'use strict';
/**
 * Oberon Director — Programme persistence.
 *
 * A Programme is a multi-stage research campaign run by the Director LLM
 * (the layer ABOVE the Fairy). Each stage is executed as one Fairy run
 * (its own quest dir under <root>/quests/); the Programme itself lives in
 * a sibling folder:
 *
 *   <root>/programmes/P01_<slug>/
 *     programme.json          ← the whole state (journaled after every mutation)
 *     literature/L01.json     ← director-level literature briefs
 *     report/report.tex       ← final concise LaTeX report (+ report.pdf best-effort)
 *
 * Everything here is deterministic and vscode-free so the director test
 * suite can exercise it headless. The workspace root is always passed in
 * explicitly (index.js supplies project.getWorkspaceRoot()).
 */

const path   = require('path');
const fsp    = require('fs/promises');
const fs     = require('fs');
const crypto = require('crypto');

const PROGRAMMES_DIR = 'programmes';

/** Statuses a programme moves through (linear, with terminal branches). */
const PROGRAMME_STATUSES = Object.freeze([
    'planning', 'running', 'synthesis', 'reporting', 'done', 'failed', 'aborted',
]);

/** Statuses one stage moves through. */
const STAGE_STATUSES = Object.freeze([
    'pending', 'running', 'delivered', 'partial', 'failed', 'skipped', 'dropped',
]);

function programmesRoot(root) {
    if (!root) return null;
    return path.join(root, PROGRAMMES_DIR);
}

/** Heuristic slug (lifted from questNaming.heuristicSlug semantics, dependency-free). */
function slugify(text, maxLen = 40) {
    const s = String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, maxLen)
        .replace(/_+$/g, '');
    return s || 'programme';
}

/** Next free P<NN> id by scanning the programmes dir. */
async function nextProgrammeId(root) {
    const dir = programmesRoot(root);
    if (!dir) throw new Error('nextProgrammeId: no workspace root');
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch (_) { entries = []; }
    let max = 0;
    for (const e of entries) {
        const m = /^P(\d{2,4})_/.exec(e);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return 'P' + String(max + 1).padStart(2, '0');
}

/**
 * Create a new Programme skeleton on disk.
 * @param {{ root: string, goal: string, title?: string }} args
 * @returns {Promise<object>} the programme object (already persisted)
 */
async function createProgramme({ root, goal, title }) {
    if (!root) throw new Error('createProgramme: root is required');
    const id   = await nextProgrammeId(root);
    const slug = slugify(title || goal);
    const dir  = path.join(programmesRoot(root), `${id}_${slug}`);
    await fsp.mkdir(path.join(dir, 'literature'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'report'),     { recursive: true });

    const programme = {
        id, slug, dir,
        title:      String(title || goal).slice(0, 200),
        goal:       String(goal).slice(0, 8000),
        status:     'planning',
        createdAt:  new Date().toISOString(),
        updatedAt:  new Date().toISOString(),
        // Filled by the plan step.
        plan: null,                 // { objective, finalDeliverable, stages: [Stage], version }
        assumptions: [],            // declared prose assumptions (clarify gate)
        // Director ledgers.
        keyResults: [],             // [{ id, stageId, statement, evidence, confidence }]
        literature: [],             // [{ id, question, briefPath, papers, stageId }]
        askUserLog: [],             // [{ question, answer, at }]
        // Bounded-mutation counters.
        replansUsed: 0,
        litConsultsUsed: 0,
        askUserUsed: 0,
        stagesRun: 0,
        // Final products.
        synthesis: null,            // { abstract, conclusions, methodSummary, ... }
        novelty:   null,            // { considerable, why, skillTitle, ... }
        contribution: null,         // { candidateId, dir, draftPath, submitted }
        report:    null,            // { texPath, pdfPath }
        outcome:   null,            // { status: 'success'|'partial'|'failed', note }
        runIds:    [],              // telemetry run ids that executed this programme
        spend:     { directorLlmCalls: 0, directorCostUSD: 0 },
    };
    await saveProgramme(programme);
    return programme;
}

/**
 * A Stage record (element of programme.plan.stages). Created via makeStage so
 * every stage carries the same shape.
 *
 * @param {{ id: string, title: string, task: string, successCriteria?: string[],
 *           validationChecks?: string[], rationale?: string }} spec
 */
function makeStage(spec) {
    return {
        id:               String(spec.id),
        title:            String(spec.title || '').slice(0, 200),
        task:             String(spec.task || '').slice(0, 6000),
        successCriteria:  clampStrArray(spec.successCriteria, 8, 400),
        validationChecks: clampStrArray(spec.validationChecks, 6, 400),
        rationale:        String(spec.rationale || '').slice(0, 500),
        status:           'pending',
        attempt:          0,
        // Execution artifacts (filled after the fairy run).
        questId:      null,
        charmDir:     null,
        cleanNbPath:  null,
        scrollStatus: null,
        confidence:   null,
        // Director analysis (filled by the assess step).
        assessment:   null,   // { verdict, surprise, keyResults, action, reason, stageNotes }
        notesForNext: '',
        startedAt:    null,
        endedAt:      null,
    };
}

function clampStrArray(arr, maxItems, maxLen) {
    if (!Array.isArray(arr)) return [];
    return arr.map(s => String(s || '').trim()).filter(Boolean)
        .map(s => s.slice(0, maxLen)).slice(0, maxItems);
}

/** Next free S<NN> stage id within a plan. */
function nextStageId(plan) {
    let max = 0;
    for (const s of (plan && plan.stages) || []) {
        const m = /^S(\d{2,4})$/.exec(s.id);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return 'S' + String(max + 1).padStart(2, '0');
}

/** Atomic persist: write tmp + rename, stamping updatedAt. */
async function saveProgramme(programme) {
    if (!programme || !programme.dir) throw new Error('saveProgramme: programme.dir missing');
    programme.updatedAt = new Date().toISOString();
    const file = path.join(programme.dir, 'programme.json');
    const tmp  = file + '.tmp';
    const json = JSON.stringify(programme, null, 2) + '\n';
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, file);
    return {
        path: file,
        sha256: 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    };
}

/** Load a programme from its directory. Throws when missing/corrupt. */
async function loadProgramme(dir) {
    const file = path.join(dir, 'programme.json');
    const raw  = await fsp.readFile(file, 'utf8');
    const p    = JSON.parse(raw);
    p.dir = dir;   // dir is authoritative from the caller (folder may have moved)
    return p;
}

/** List programmes (newest first) with minimal metadata for pickers. */
async function listProgrammes(root) {
    const dir = programmesRoot(root);
    if (!dir) return [];
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch (_) { return []; }
    const out = [];
    for (const e of entries.sort().reverse()) {
        const pDir = path.join(dir, e);
        try {
            if (!fs.statSync(pDir).isDirectory()) continue;
            const p = JSON.parse(fs.readFileSync(path.join(pDir, 'programme.json'), 'utf8'));
            out.push({
                id: p.id, title: p.title, status: p.status, dir: pDir,
                createdAt: p.createdAt, updatedAt: p.updatedAt,
                stages: Array.isArray(p.plan && p.plan.stages) ? p.plan.stages.length : 0,
            });
        } catch (_) { /* skip unreadable */ }
    }
    return out;
}

/** Persist a literature brief JSON under <programme>/literature/, return its record. */
async function saveLiteratureBrief(programme, { question, brief, stageId }) {
    const idx = (programme.literature || []).length + 1;
    const id  = 'L' + String(idx).padStart(2, '0');
    const file = path.join(programme.dir, 'literature', `${id}.json`);
    await fsp.writeFile(file, JSON.stringify({ id, question, stageId: stageId || null, brief }, null, 2) + '\n', 'utf8');
    const rec = {
        id, question: String(question).slice(0, 400), briefPath: file,
        stageId: stageId || null,
        papers: Array.isArray(brief && brief.papers)
            ? brief.papers.map(p => ({
                title: p.title, year: p.year, arxivId: p.arxivId || null,
                doi: p.doi || null, inspireId: p.inspireId || null,
                authors: (p.authors || []).slice(0, 4), ref: p.ref || null,
                reason: String(p.reason || '').slice(0, 300),
            }))
            : [],
        observations: Array.isArray(brief && brief.observations)
            ? brief.observations.slice(0, 10).map(o => ({
                text: String((o && o.text) || o || '').slice(0, 400),
                source: (o && o.source) || null,
            }))
            : [],
    };
    programme.literature.push(rec);
    return rec;
}

/** Append a key result (dedup by normalized statement). */
function addKeyResult(programme, { stageId, statement, evidence, confidence }) {
    const stmt = String(statement || '').trim().slice(0, 1200);
    if (!stmt) return null;
    const norm = stmt.toLowerCase().replace(/\s+/g, ' ');
    for (const kr of programme.keyResults) {
        if (kr.statement.toLowerCase().replace(/\s+/g, ' ') === norm) return kr;
    }
    const rec = {
        id: 'K' + String(programme.keyResults.length + 1).padStart(2, '0'),
        stageId: stageId || null,
        statement: stmt,
        evidence: String(evidence || '').slice(0, 800),
        confidence: (typeof confidence === 'number' && confidence >= 0 && confidence <= 1) ? confidence : 0.5,
    };
    programme.keyResults.push(rec);
    return rec;
}

/** Render the key-results block injected into stage tasks (do-not-rederive). */
function renderKeyResultsBlock(programme, { maxChars = 2400 } = {}) {
    const krs = programme.keyResults || [];
    if (!krs.length) return '';
    const lines = ['ESTABLISHED RESULTS from earlier stages (verified in the kernel — build on these, do NOT re-derive):'];
    for (const kr of krs) {
        const line = `- [${kr.stageId || '?'} · conf ${Number(kr.confidence).toFixed(2)}] ${kr.statement}`;
        lines.push(line);
        if (lines.join('\n').length > maxChars) { lines.pop(); lines.push('- … (further results truncated)'); break; }
    }
    return lines.join('\n');
}

module.exports = {
    PROGRAMMES_DIR, PROGRAMME_STATUSES, STAGE_STATUSES,
    programmesRoot, slugify, nextProgrammeId,
    createProgramme, makeStage, nextStageId, clampStrArray,
    saveProgramme, loadProgramme, listProgrammes,
    saveLiteratureBrief, addKeyResult, renderKeyResultsBlock,
};
