'use strict';
/**
 * Oberon Fairy — per-run working directory.
 *
 * Manages the filesystem artefacts for one Charm run:
 *
 *   <charmDir>/
 *     working.wb        — probe scratch pad (append-only .wb notebook JSON)
 *     clean.wb          — compiled deliverable (written by harness)
 *     steps.json        — working chain: accepted probes in record order
 *     assumptions.json  — mathematical side conditions
 *     inputs.json       — task inputs (written once at Intake)
 *     results/
 *       <probeId>.json  — full probe result (value, messages, structural info)
 *     log.jsonl         — append-only event log for this run
 *
 * No vscode dependency — takes an absolute charmDir path. The caller
 * (fairy.js) computes charmDir via project.questsDir().
 *
 * API:
 *   createWorkDir(charmDir)  → Promise<WorkDir>   (creates dirs + empty files)
 *   openWorkDir(charmDir)    → WorkDir             (opens existing, lazy reads)
 */

const path   = require('path');
const fsp    = require('fs/promises');
const crypto = require('crypto');

// ── Notebook helpers ────────────────────────────────────────────────────────

function makeCell(value, kind = 2, tags = [], id = null) {
    return {
        id:         id || crypto.randomBytes(4).toString('hex'),
        kind,
        languageId: kind === 2 ? 'wolfram' : 'markdown',   // VS Code API field name
        value,
        outputs:    [],
        metadata:   tags.length ? { tags } : {},
    };
}

function makeMarkupCell(value, tags = []) {
    return makeCell(value, 1, tags);
}

/**
 * Build the ordered cell array for a clean notebook without writing to disk.
 * Used by both writeCleanNotebook (raw JSON path) and external VS Code API writers.
 *
 * @param {{ steps: object[], inputs: object[], assumptions: object[], taskTitle?: string }} args
 * @returns {Array<{ kind: number, languageId: string, value: string, outputs: [], metadata: object }>}
 */
function buildCleanCells({ steps, inputs, assumptions, taskTitle, utils, skillsBlock, suppressionCode }) {
    const cells = [];

    // Header markup cell
    const assumSummary = (assumptions || []).length
        ? '\nAssumptions: ' + assumptions.map(a => a.statement).join('; ')
        : '';
    const headerLines = [
        'Wolfbook Fairy — compiled clean notebook',
        taskTitle ? `Task: ${taskTitle}` : null,
        assumSummary ? assumSummary.trim() : null,
    ].filter(Boolean).join('\n');
    cells.push(makeMarkupCell(headerLines, ['header']));

    // Transparent suppression cell: the same non-critical solver warnings the agent
    // silenced during exploration are turned off here too, so re-running this notebook
    // in a fresh kernel behaves identically (and the user sees exactly what was off).
    if (suppressionCode && String(suppressionCode).trim()) {
        cells.push(makeMarkupCell('## Suppressed non-critical warnings', ['suppress-header']));
        cells.push(makeCell(`(* Non-critical solver/convergence warnings — off so they don't clutter results *)\n${String(suppressionCode).trim()}`, 2, ['suppress']));
    }

    // Utility definitions (registered via define_util) — MUST come before any step
    // that calls them, or the clean notebook fails on a fresh kernel. Emit only utils
    // actually referenced: by a step, or transitively by another emitted util (so a
    // helper called only from inside another helper is still included). Keeps clean.wb
    // focused while remaining self-contained for restart-and-verify.
    const utilList = Array.isArray(utils) ? utils : [];
    if (utilList.length) {
        const byName = new Map(utilList.filter(u => u && u.name).map(u => [u.name, u]));
        const stepCode = (steps || []).map(s => s.code || '').join('\n');
        const used = new Set();
        const mark = (code) => {
            for (const u of utilList) {
                if (u && u.name && !used.has(u.name) && new RegExp(`\\b${u.name}\\b`).test(code)) used.add(u.name);
            }
        };
        mark(stepCode);
        // Transitive closure over util→util references.
        let changed = true;
        while (changed) {
            changed = false;
            for (const name of [...used]) {
                const before = used.size;
                mark((byName.get(name) || {}).code || '');
                if (used.size !== before) changed = true;
            }
        }
        // Emit in registration order, only the referenced ones.
        const emit = utilList.filter(u => u && u.name && used.has(u.name));
        if (emit.length) {
            cells.push(makeMarkupCell('## Helper definitions', ['utils-header']));
            for (const u of emit) {
                cells.push(makeCell(`(* util: ${u.name}${u.note ? ' — ' + u.note : ''} *)\n${u.code}`, 2, ['util', u.name]));
            }
        }
    }

    // Input cells
    for (const inp of (inputs || [])) {
        if (inp.code) {
            cells.push(makeCell(
                `(* Input: ${inp.id || ''} *)\n${inp.code}`,
                2, ['input', inp.id || ''],
            ));
        }
    }

    // $Assumptions cell
    if ((assumptions || []).length) {
        const wlExprs = assumptions.map(a => a.wlAssumption).filter(Boolean);
        const assumCell = wlExprs.length > 0
            ? `$Assumptions = And[${wlExprs.join(', ')}];`
            : `$Assumptions = True;`;
        cells.push(makeCell(assumCell, 2, ['assumptions']));
    }

    // Step cells (exact recorded code, tagged with stepId)
    for (const step of (steps || [])) {
        const note = step.note ? `(* ${step.note} *)\n` : '';
        cells.push(makeCell(note + step.code, 2, ['step', step.id], step.id + '_cell'));
    }

    // Skills-used + citation block (markdown), appended at the end.
    if (skillsBlock && String(skillsBlock).trim()) {
        cells.push(makeMarkupCell(String(skillsBlock), ['skills-used']));
    }

    return cells;
}

/** Read an existing .wb notebook JSON, returning { cells: [] } on any error. */
async function readNotebook(nbPath) {
    try {
        const raw = await fsp.readFile(nbPath, 'utf8');
        const nb  = JSON.parse(raw);
        if (!Array.isArray(nb.cells)) return { cells: [] };
        return nb;
    } catch (_) {
        return { cells: [] };
    }
}

/** Overwrite a .wb notebook with the given cells array. */
async function writeNotebook(nbPath, cells) {
    await fsp.writeFile(nbPath, JSON.stringify({ cells }, null, 2), 'utf8');
}

/** Append a single cell to a .wb notebook. Creates the notebook if absent. */
async function appendCell(nbPath, cell) {
    const nb = await readNotebook(nbPath);
    nb.cells.push(cell);
    await writeNotebook(nbPath, nb.cells);
}

// ── WorkDir class ───────────────────────────────────────────────────────────

class WorkDir {
    /**
     * @param {string} charmDir  absolute path to the charm working directory
     */
    constructor(charmDir) {
        this._dir        = charmDir;
        this._resultsDir = path.join(charmDir, 'results');
    }

    get dir()             { return this._dir; }
    get workingNb()       { return path.join(this._dir, 'working.wb'); }
    get cleanNb()         { return path.join(this._dir, 'clean.wb'); }
    get partialNb()       { return path.join(this._dir, 'clean_partial.wb'); }
    get checkpointNb()    { return path.join(this._dir, 'clean_in_progress.wb'); }
    get stepsFile()       { return path.join(this._dir, 'steps.json'); }
    get assumFile()       { return path.join(this._dir, 'assumptions.json'); }
    get inputsFile()      { return path.join(this._dir, 'inputs.json'); }
    get utilsFile()       { return path.join(this._dir, 'utils.json'); }
    get planFile()        { return path.join(this._dir, 'plan.json'); }
    get factsFile()       { return path.join(this._dir, 'facts.json'); }
    get citedSkillsFile() { return path.join(this._dir, 'cited_skills.json'); }
    get literatureFile()  { return path.join(this._dir, 'literature.json'); }
    get logFile()         { return path.join(this._dir, 'log.jsonl'); }

    // ── Probe counter ──────────────────────────────────────────────────────

    /**
     * Return the next 1-based probe counter by counting existing result files.
     * Thread-safe within a single Node.js process (no concurrent runs share a workDir).
     * @returns {Promise<number>}
     */
    async nextProbeCounter() {
        let files = [];
        try { files = await fsp.readdir(this._resultsDir); } catch (_) {}
        return files.filter(f => f.endsWith('.json')).length + 1;
    }

    // ── Probe results ──────────────────────────────────────────────────────

    /**
     * Save a probe result to results/<probeId>.json AND append a scratch cell
     * to working.wb.
     *
     * @param {string} probeId
     * @param {{
     *   code:             string,
     *   ok:               boolean,
     *   value:            string|null,
     *   messages:         string|null,
     *   prints:           string|null,
     *   durationMs:       number,
     *   structuralSummary: object,
     *   error:            string|null,
     * }} probeData
     */
    async saveProbe(probeId, probeData) {
        const ts = new Date().toISOString();
        const record = { probeId, ts, ...probeData };
        const resultPath = path.join(this._resultsDir, `${probeId}.json`);
        await fsp.writeFile(resultPath, JSON.stringify(record, null, 2), 'utf8');
        // Notebook cells for working.wb are inserted live via the wolfbook controller
        // in evalInNotebook — no disk writes here. The disk working.wb.json is only
        // used to initialise the empty notebook at run start.
    }

    /**
     * Load a probe result by probeId.
     * @param {string} probeId
     * @returns {Promise<object|null>}
     */
    async getProbe(probeId) {
        const p = path.join(this._resultsDir, `${probeId}.json`);
        try {
            const raw = await fsp.readFile(p, 'utf8');
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    /**
     * Load the most recent N probe results (by probeId order), newest last.
     * Used by the near-duplicate-probe guard. Returns [] on missing dir.
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async loadRecentProbes(limit = 6) {
        let files = [];
        try { files = await fsp.readdir(this._resultsDir); } catch (_) { return []; }
        const ids = files.filter(f => /^p\d+\.json$/.test(f)).sort();   // p001 < p002 < …
        const pick = ids.slice(-Math.max(1, limit));
        const out = [];
        for (const f of pick) {
            try { out.push(JSON.parse(await fsp.readFile(path.join(this._resultsDir, f), 'utf8'))); } catch (_) {}
        }
        return out;
    }

    // ── Steps ──────────────────────────────────────────────────────────────

    /**
     * Load all steps from disk. Returns [] on missing/invalid file.
     */
    async loadAllSteps() {
        try {
            const raw = await fsp.readFile(this.stepsFile, 'utf8');
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    /** Load only valid (non-stale) steps. */
    async loadValidSteps() {
        const all = await this.loadAllSteps();
        return all.filter(s => s.status === 'valid');
    }

    /**
     * Append a new step to steps.json.
     *
     * @param {{
     *   id:             string,
     *   probeId:        string,
     *   code:           string,
     *   resultRef:      string,   // probeId (path: results/<probeId>.json)
     *   dependsOn:      string[],
     *   usesSymbols:    string[],
     *   definesSymbols: string[],
     *   note:           string,
     * }} step
     */
    async addStep(step) {
        const all = await this.loadAllSteps();
        const full = {
            ...step,
            status:     'valid',
            recordedAt: new Date().toISOString(),
        };
        all.push(full);
        await fsp.writeFile(this.stepsFile, JSON.stringify(all, null, 2), 'utf8');
        return full;
    }

    /**
     * Mark a step and all transitively-dependent steps as 'stale'.
     * Returns { prunedStepIds, keptStepIds }.
     *
     * @param {string} fromStepId
     */
    async markStale(fromStepId) {
        const all = await this.loadAllSteps();

        // Build reverse-dependency map: stepId → steps that depend on it
        const dependents = new Map();
        for (const s of all) {
            for (const dep of (s.dependsOn || [])) {
                if (!dependents.has(dep)) dependents.set(dep, []);
                dependents.get(dep).push(s.id);
            }
        }

        // BFS from fromStepId to collect all transitively-dependent step ids
        const toPrune = new Set([fromStepId]);
        const queue   = [fromStepId];
        while (queue.length) {
            const cur = queue.shift();
            for (const dep of (dependents.get(cur) || [])) {
                if (!toPrune.has(dep)) {
                    toPrune.add(dep);
                    queue.push(dep);
                }
            }
        }

        const prunedStepIds = [];
        const keptStepIds   = [];
        for (const s of all) {
            if (toPrune.has(s.id)) {
                s.status = 'stale';
                prunedStepIds.push(s.id);
            } else {
                keptStepIds.push(s.id);
            }
        }

        await fsp.writeFile(this.stepsFile, JSON.stringify(all, null, 2), 'utf8');

        // Delete draft clean.wb if it exists
        try { await fsp.unlink(this.cleanNb); } catch (_) {}

        return { prunedStepIds, keptStepIds };
    }

    // ── Assumptions ────────────────────────────────────────────────────────

    async loadAssumptions() {
        try {
            const raw = await fsp.readFile(this.assumFile, 'utf8');
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    /**
     * Upsert an assumption by id.
     * @param {{ id: string, statement: string, wlAssumption?: string }} assumption
     */
    async upsertAssumption(assumption) {
        const all = await this.loadAssumptions();
        const idx = all.findIndex(a => a.id === assumption.id);
        if (idx >= 0) {
            all[idx] = { ...assumption, updatedAt: new Date().toISOString() };
        } else {
            all.push({ ...assumption, createdAt: new Date().toISOString() });
        }
        await fsp.writeFile(this.assumFile, JSON.stringify(all, null, 2), 'utf8');
        return all;
    }

    // ── Inputs ─────────────────────────────────────────────────────────────

    async setInputs(inputs) {
        await fsp.writeFile(this.inputsFile, JSON.stringify(inputs, null, 2), 'utf8');
    }

    async loadInputs() {
        try {
            const raw = await fsp.readFile(this.inputsFile, 'utf8');
            return JSON.parse(raw);
        } catch (_) {
            return [];
        }
    }

    // ── Log ────────────────────────────────────────────────────────────────

    async appendLog(event) {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
        await fsp.appendFile(this.logFile, line, 'utf8');
    }

    // ── Clean notebook (compiled deliverable) ──────────────────────────────

    /**
     * Build and write clean.wb from the given steps + inputs + assumptions.
     *
     * clean.wb layout:
     *   1. Header comment cell (task description + assumptions summary)
     *   2. inputs.json cells (one code cell per input)
     *   3. $Assumptions cell (if any assumptions)
     *   4. One code cell per step (exact recorded code, tagged with stepId)
     *
     * @param {{
     *   steps:       object[],   // valid steps in closure order
     *   inputs:      object[],   // task inputs
     *   assumptions: object[],   // mathematical assumptions
     *   taskTitle?:  string,
     * }} args
     */
    async writeCleanNotebook({ steps, inputs, assumptions, taskTitle, utils, skillsBlock, suppressionCode }) {
        const utilList = utils ?? await this.loadUtils().catch(() => []);
        const cells = buildCleanCells({ steps, inputs, assumptions, taskTitle, utils: utilList, skillsBlock, suppressionCode });
        await writeNotebook(this.cleanNb, cells);
        return this.cleanNb;
    }

    /**
     * Write clean_partial.wb — a structured report for runs that exhausted budget.
     * Includes the partial step chain (unverified), what failed, open questions,
     * and agent recommendations. Oberon uses this to decide how to refactor the task.
     *
     * @param {{ steps, inputs, assumptions, taskTitle, summary, failedAttempts, openQuestions, recommendations }} args
     */
    async writePartialNotebook({ steps, inputs, assumptions, taskTitle, summary, failedAttempts = [], openQuestions = [], recommendations }) {
        const cells = [];

        // Header — clearly marked as partial
        const headerLines = [
            '⚠️ PARTIAL RESULTS — Probe Budget Exhausted',
            taskTitle ? `Task: ${taskTitle}` : null,
            '',
            summary || 'Budget exhausted before the chain could be completed and verified.',
            '',
            'Results below are INCOMPLETE and UNVERIFIED. Use this report to refactor or narrow the task.',
        ].filter(l => l !== null).join('\n');
        cells.push(makeMarkupCell(headerLines, ['header', 'partial']));

        // Inputs
        for (const inp of (inputs || [])) {
            if (inp.code) {
                cells.push(makeCell(
                    `(* Input: ${inp.id || ''} *)\n${inp.code}`,
                    2, ['input', inp.id || ''],
                ));
            }
        }

        // Assumptions cell
        if ((assumptions || []).length) {
            const wlExprs = assumptions.map(a => a.wlAssumption).filter(Boolean);
            const assumCell = wlExprs.length > 0
                ? `$Assumptions = And[${wlExprs.join(', ')}];`
                : `$Assumptions = True;`;
            cells.push(makeCell(assumCell, 2, ['assumptions']));
        }

        // Partial chain — steps that were successfully recorded (unverified)
        if ((steps || []).length) {
            cells.push(makeMarkupCell(
                '## Partial Chain (recorded steps — NOT verified in a fresh kernel)\n\nThese steps ran cleanly in the scratchpad kernel but have not been verified in a fresh kernel.',
                ['partial-chain-header'],
            ));
            for (const step of steps) {
                const note = step.note ? `(* ${step.note} *)\n` : '';
                cells.push(makeCell(note + step.code, 2, ['step', step.id, 'partial'], step.id + '_cell'));
            }
        } else {
            cells.push(makeMarkupCell('## Partial Chain\n\nNo steps were successfully recorded before budget exhaustion.', ['partial-chain-header']));
        }

        // What failed
        if (failedAttempts.length) {
            const failMd = '## What Failed\n\n' + failedAttempts.map(f => `- ${f}`).join('\n');
            cells.push(makeMarkupCell(failMd, ['failed-attempts']));
        }

        // Open questions
        if (openQuestions.length) {
            const openMd = '## Open Questions (unresolved)\n\n' + openQuestions.map(q => `- ${q}`).join('\n');
            cells.push(makeMarkupCell(openMd, ['open-questions']));
        }

        // Recommendations for Oberon
        if (recommendations) {
            const recMd = '## Recommendations for Next Run\n\n' + recommendations;
            cells.push(makeMarkupCell(recMd, ['recommendations']));
        }

        await writeNotebook(this.partialNb, cells);
        return this.partialNb;
    }

    // ── Utility functions (define_util) ────────────────────────────────────

    /**
     * Load the registered utility definitions. Returns [] when no utils defined.
     * @returns {Promise<Array<{name:string, code:string, note:string, definedAt:string}>>}
     */
    async loadUtils() {
        try {
            const raw = await fsp.readFile(this.utilsFile, 'utf8');
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    /**
     * Register a utility function. Overwrites any existing entry with the same name.
     * @param {{ name: string, code: string, note: string }} util
     */
    async addUtil({ name, code, note }) {
        const all = await this.loadUtils();
        const idx = all.findIndex(u => u.name === name);
        const entry = { name, code, note, definedAt: new Date().toISOString() };
        if (idx >= 0) {
            all[idx] = entry;
        } else {
            all.push(entry);
        }
        await fsp.writeFile(this.utilsFile, JSON.stringify(all, null, 2), 'utf8');
        return entry;
    }

    /**
     * Return all registered utility definitions as a single WL string suitable
     * for prepending to a probe. Empty string when no utils are defined.
     * @returns {Promise<string>}
     */
    async getUtilsCode() {
        const utils = await this.loadUtils();
        if (!utils.length) return '';
        return utils.map(u => `(* util: ${u.name} *)\n${u.code}`).join('\n');
    }

    // ── Plan (plan tool) ───────────────────────────────────────────────────

    /**
     * Persist the fairy's execution plan.
     * @param {{ steps: string[], note?: string }} plan
     */
    async savePlan({ steps, note = '' }) {
        const data = { steps: steps.map(String), note: String(note || ''), createdAt: new Date().toISOString() };
        await fsp.writeFile(this.planFile, JSON.stringify(data, null, 2), 'utf8');
        return data;
    }

    /** Load the plan, or null if not yet set. */
    async loadPlan() {
        try {
            return JSON.parse(await fsp.readFile(this.planFile, 'utf8'));
        } catch (_) { return null; }
    }

    // ── Results / fact ledger (R2) ─────────────────────────────────────────

    /** Load all established facts. Returns [] on missing/invalid file. */
    async loadFacts() {
        try {
            const arr = JSON.parse(await fsp.readFile(this.factsFile, 'utf8'));
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }

    // ── Cited skills (cite_skill tool) ──────────────────────────────────────
    // The agent EXPLICITLY declares which recalled skill(s) it actually used and how.
    // This is the authoritative "skill was used" signal — replacing the old, false-
    // positive-prone token-overlap heuristic (FAIRY_SKILL_ATTRIBUTION_FRICTION_22JUN).

    /** Load all skills the agent cited as used. Returns [] on missing/invalid. */
    async loadCitedSkills() {
        try {
            const arr = JSON.parse(await fsp.readFile(this.citedSkillsFile, 'utf8'));
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }

    // ── Literature briefs (research_literature tool) ────────────────────────

    /** Load all literature briefs from this run. Returns [] on missing/invalid. */
    async loadLiteratureBriefs() {
        try {
            const arr = JSON.parse(await fsp.readFile(this.literatureFile, 'utf8'));
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }

    /** Append a literature brief (deduped by question). */
    async addLiteratureBrief(brief) {
        const all = await this.loadLiteratureBriefs();
        const q = String((brief && brief.question) || '');
        const idx = all.findIndex(b => b.question === q);
        const entry = { ...brief, addedAt: new Date().toISOString() };
        if (idx >= 0) all[idx] = entry; else all.push(entry);
        await fsp.writeFile(this.literatureFile, JSON.stringify(all, null, 2), 'utf8');
        return entry;
    }

    /**
     * Record an agent citation of a recalled skill. Upserts by skillRef.
     * @param {{ skillRef:string, how:string }} cite
     */
    async addCitedSkill({ skillRef, how }) {
        const all = await this.loadCitedSkills();
        const entry = { skillRef: String(skillRef), how: String(how || ''), citedAt: new Date().toISOString() };
        const idx = all.findIndex(c => c.skillRef === entry.skillRef);
        if (idx >= 0) all[idx] = entry; else all.push(entry);
        await fsp.writeFile(this.citedSkillsFile, JSON.stringify(all, null, 2), 'utf8');
        return entry;
    }

    /**
     * Record an established result. Upserts by key (latest value wins).
     * @param {{ key:string, value:string, confidence?:string, provenance?:string }} fact
     */
    async addFact({ key, value, confidence = 'medium', provenance = '' }) {
        const all = await this.loadFacts();
        const entry = {
            key:        String(key),
            value:      String(value),
            confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium',
            provenance: String(provenance || ''),
            notedAt:    new Date().toISOString(),
        };
        const idx = all.findIndex(f => f.key === entry.key);
        if (idx >= 0) all[idx] = entry; else all.push(entry);
        await fsp.writeFile(this.factsFile, JSON.stringify(all, null, 2), 'utf8');
        return entry;
    }

    /**
     * Build a verbatim ledger of definitions (R3) for compaction-safe preservation:
     * registered util bodies + valid recorded-step code, exactly as written. This is
     * NEVER summarised — it is prepended to the history after compaction so the model
     * keeps the exact code of everything alive in the kernel.
     * @param {{ maxChars?: number }} [opts]
     * @returns {Promise<string>}
     */
    async buildDefinitionsLedger({ maxChars = 4000 } = {}) {
        const [utils, steps] = await Promise.all([
            this.loadUtils().catch(() => []),
            this.loadValidSteps().catch(() => []),
        ]);
        const blocks = [];
        for (const u of utils) {
            blocks.push(`(* util: ${u.name} — ${(u.note || '').slice(0, 80)} *)\n${u.code}`);
        }
        for (const s of steps) {
            const defs = (s.definesSymbols || []).filter(Boolean).join(', ');
            blocks.push(`(* step ${s.id}${defs ? ' defines ' + defs : ''} — ${(s.note || '').slice(0, 80)} *)\n${s.code || ''}`);
        }
        if (!blocks.length) return '';
        let out = blocks.join('\n\n');
        if (out.length > maxChars) out = out.slice(0, maxChars) + '\n(* … definitions ledger truncated *)';
        return out;
    }

    /**
     * Build a compact ledger of established results for injection into context.
     * @param {{ maxChars?: number }} [opts]
     * @returns {Promise<string>}  one fact per line, or '' if none.
     */
    async buildFactsLedger({ maxChars = 1200 } = {}) {
        const facts = await this.loadFacts();
        if (!facts.length) return '';
        // High-confidence first so the most trustworthy facts survive truncation.
        const order = { high: 0, medium: 1, low: 2 };
        const sorted = [...facts].sort((a, b) => (order[a.confidence] ?? 1) - (order[b.confidence] ?? 1));
        const lines = sorted.map(f => {
            const prov = f.provenance ? ` (${f.provenance})` : '';
            const val  = (f.value || '').slice(0, 120);
            return `[${f.confidence}] ${f.key} = ${val}${prov}`;
        });
        let out = lines.join('\n');
        if (out.length > maxChars) {
            out = out.slice(0, maxChars);
            const lastNl = out.lastIndexOf('\n');
            if (lastNl > 0) out = out.slice(0, lastNl);
            out += '\n… [facts ledger truncated]';
        }
        return out;
    }

    // ── Live kernel symbol table (M7) ──────────────────────────────────────

    /**
     * Build a compact digest of symbols currently alive in the kernel — registered
     * utils plus symbols defined by valid recorded steps. Injected into the model's
     * context so it CALLS existing symbols instead of rebuilding them.
     *
     * @param {{ maxChars?: number }} [opts]
     * @returns {Promise<string>}  one symbol per line, or '' if nothing is defined.
     */
    async buildSymbolTable({ maxChars = 1200 } = {}) {
        const [utils, steps] = await Promise.all([
            this.loadUtils().catch(() => []),
            this.loadValidSteps().catch(() => []),
        ]);

        const lines = [];
        for (const u of utils) {
            const note = (u.note || '').slice(0, 60);
            lines.push(`${u.name}  — util — ${note}`);
        }
        for (const s of steps) {
            const defs = (s.definesSymbols || []).filter(Boolean);
            const label = defs.length ? defs.join(', ') : (s.id || 'step');
            const note  = (s.note || '').slice(0, 60);
            // R9: mark high-confidence steps as established memory.
            const conf  = s.confidence === 'high' ? ' [established]' : '';
            lines.push(`${label}  — ${s.id || 'step'}${conf} — ${note}`);
        }

        if (!lines.length) return '';

        let out = lines.join('\n');
        if (out.length > maxChars) {
            // Trim to the line boundary under the cap, append an ellipsis marker.
            out = out.slice(0, maxChars);
            const lastNl = out.lastIndexOf('\n');
            if (lastNl > 0) out = out.slice(0, lastNl);
            out += '\n… [symbol table truncated]';
        }
        return out;
    }

    /**
     * Structured ledger data for rendering a readable notebook table (O7 polish).
     * Distinct from buildSymbolTable (a compact string for the LLM context).
     * @returns {Promise<{ symbols: object[], facts: object[] }>}
     */
    async buildLedgerData() {
        const [utils, steps, facts] = await Promise.all([
            this.loadUtils().catch(() => []),
            this.loadValidSteps().catch(() => []),
            this.loadFacts().catch(() => []),
        ]);
        const symbols = [];
        for (const u of utils) {
            symbols.push({ name: u.name, kind: 'util', note: (u.note || '').trim() });
        }
        for (const s of steps) {
            const defs = (s.definesSymbols || []).filter(Boolean);
            symbols.push({
                name: defs.length ? defs.join(', ') : (s.id || 'step'),
                kind: (s.id || 'step') + (s.confidence === 'high' ? ' ✓' : ''),
                note: (s.note || '').trim(),
            });
        }
        const order = { high: 0, medium: 1, low: 2 };
        const factRows = [...facts]
            .sort((a, b) => (order[a.confidence] ?? 1) - (order[b.confidence] ?? 1))
            .map(f => ({ key: f.key, confidence: f.confidence || 'medium', value: (f.value || '').trim(), provenance: f.provenance || '' }));
        return { symbols, facts: factRows };
    }

    // ── Checkpoint sections (checkpoint tool) ──────────────────────────────

    /**
     * Append a named section to clean_in_progress.wb. Creates the file if absent.
     * Each section gets a markdown header cell followed by step code cells.
     *
     * @param {{
     *   sectionTitle: string,
     *   steps:        object[],
     *   inputs:       object[],
     *   assumptions:  object[],
     * }} args
     */
    async appendCheckpointSection({ sectionTitle, steps, inputs, assumptions }) {
        const nb = await readNotebook(this.checkpointNb);

        // O4: dedupe — collect stepIds already committed in earlier sections (from cell
        // metadata tags) and skip them, so a later checkpoint never re-includes a step
        // already present. Re-defining the same symbols across sections is exactly what
        // makes clean_in_progress.wb run with redefinition warnings.
        const committed = new Set();
        for (const c of (nb.cells || [])) {
            const tags = (c && c.metadata && c.metadata.tags) || [];
            const i = tags.indexOf('step');
            if (i >= 0 && tags[i + 1]) committed.add(tags[i + 1]);
        }
        const freshSteps = (steps || []).filter(s => s && !committed.has(s.id));
        if (!freshSteps.length && nb.cells.length > 0) {
            // Nothing new to add — still record the section header so intent is visible.
            nb.cells.push(makeMarkupCell(`## ${sectionTitle}\n\n*(all steps already committed in earlier sections)*`, ['checkpoint-section', sectionTitle]));
            await writeNotebook(this.checkpointNb, nb.cells);
            return this.checkpointNb;
        }

        // On first section write, prepend a file-level header
        if (nb.cells.length === 0) {
            nb.cells.push(makeMarkupCell('# Wolfbook Fairy — Checkpoint Notebook\n\nThis file accumulates committed sub-results written during the explore phase.', ['checkpoint-header']));
            // Inputs and assumptions once at the top
            for (const inp of (inputs || [])) {
                if (inp.code) nb.cells.push(makeCell(`(* Input: ${inp.id || ''} *)\n${inp.code}`, 2, ['input', inp.id || '']));
            }
            if ((assumptions || []).length) {
                const wlExprs = assumptions.map(a => a.wlAssumption).filter(Boolean);
                if (wlExprs.length) nb.cells.push(makeCell(`$Assumptions = And[${wlExprs.join(', ')}];`, 2, ['assumptions']));
            }
        }

        // Section header
        nb.cells.push(makeMarkupCell(`## ${sectionTitle}`, ['checkpoint-section', sectionTitle]));

        // Step cells (only the not-yet-committed ones). The `['step', step.id]` tag
        // pair is what the dedupe pass above reads.
        for (const step of freshSteps) {
            const note = step.note ? `(* ${step.note} *)\n` : '';
            nb.cells.push(makeCell(note + step.code, 2, ['step', step.id, 'checkpoint'], step.id + '_ck'));
        }

        await writeNotebook(this.checkpointNb, nb.cells);
        return this.checkpointNb;
    }

    // ── Chain summary ──────────────────────────────────────────────────────

    /**
     * Build a bounded chain summary for the model's `chain` tool response.
     * Returns a JSON-serialisable object, not a string (caller serialises).
     *
     * @param {{ maxChars?: number }} [opts]
     */
    async buildChainSummary({ maxChars = 3000 } = {}) {
        const [steps, assumptions, inputs] = await Promise.all([
            this.loadValidSteps(),
            this.loadAssumptions(),
            this.loadInputs(),
        ]);

        const stepSummaries = steps.map(s => ({
            id:             s.id,
            probeId:        s.probeId,
            codePreview:    String(s.code || '').slice(0, 120),
            definesSymbols: s.definesSymbols || [],
            usesSymbols:    (s.usesSymbols || []).slice(0, 10),
            dependsOn:      s.dependsOn || [],
            note:           s.note || '',
        }));

        const summary = { inputs, steps: stepSummaries, assumptions };
        const raw = JSON.stringify(summary, null, 2);
        if (raw.length <= maxChars) return summary;
        // If too large, trim step code previews and reserialise
        const trimmed = {
            inputs,
            assumptions,
            steps: stepSummaries.map(s => ({ ...s, codePreview: s.codePreview.slice(0, 40) })),
        };
        return trimmed;
    }
}

// ── Factory functions ───────────────────────────────────────────────────────

/**
 * Create a fresh working directory for a new Charm run. Idempotent — safe to
 * call if the directory already partially exists.
 *
 * @param {string} charmDir
 * @returns {Promise<WorkDir>}
 */
async function createWorkDir(charmDir) {
    const wd = new WorkDir(charmDir);
    await fsp.mkdir(path.join(charmDir, 'results'), { recursive: true });

    // Initialise files only if absent — idempotent
    for (const [file, init] of [
        [wd.stepsFile,   '[]'],
        [wd.assumFile,   '[]'],
        [wd.inputsFile,  '[]'],
    ]) {
        try { await fsp.access(file); }
        catch (_) { await fsp.writeFile(file, init, 'utf8'); }
    }
    // working.wb starts empty (no log either — appendFile creates it lazily)
    try { await fsp.access(wd.workingNb); }
    catch (_) { await writeNotebook(wd.workingNb, []); }

    return wd;
}

/**
 * Open an existing working directory (no filesystem writes).
 *
 * @param {string} charmDir
 * @returns {WorkDir}
 */
function openWorkDir(charmDir) {
    return new WorkDir(charmDir);
}

module.exports = { WorkDir, createWorkDir, openWorkDir, buildCleanCells };
