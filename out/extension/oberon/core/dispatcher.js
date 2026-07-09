'use strict';
/**
 * Oberon — Dispatcher.
 *
 * Turns an accepted Quest into ONE Charm (a single, scoped work unit) that
 * the Fairy will attempt. MVP-2: deterministic transform — no LLM call,
 * no cost, fully predictable. Once the Skeptic loop lands (MVP-3) we may
 * promote this to an LLM-driven planner that decomposes a Quest into
 * multiple Charms; for now, one Quest = one Charm.
 *
 * Persists the Charm under <workspace>/quests/<questId>_<short>/charms/<charmId>.json
 * and emits a `charm.dispatched` telemetry event. Caller is responsible for
 * the FSM transition (`QUEST_DEFINED → CHARM_DISPATCHED`).
 */

const path   = require('path');
const fsp    = require('fs/promises');
const crypto = require('crypto');

const project = require('../memory/project');
const { validateCharm } = require('./schemas');

/**
 * @param {{
 *   quest: object,                              // validated Quest
 *   bus:   import('../telemetry/bus').TelemetryBus,
 *   spanId?: string,
 * }} args
 * @returns {Promise<{ charm: object, fileRef: { path: string, sha256: string } }>}
 */
async function dispatchCharm(args) {
    const quest = args && args.quest;
    if (!quest || !quest.id) throw new Error('dispatchCharm: quest is required');
    const bus    = args.bus;
    const spanId = args.spanId;

    const charm = buildCharm(quest);
    const v = validateCharm(charm);
    if (!v.ok) {
        const err = new Error(`Dispatcher built an invalid Charm: ${v.errors.join('; ')}`);
        err.kind = 'dispatcher_invalid';
        err.detail = { errors: v.errors };
        throw err;
    }
    const validated = v.value;

    const fileRef = await writeCharm(quest, validated);

    if (bus) {
        await bus.appendEvent('charm.dispatched', {
            questId:   quest.id,
            charmId:   validated.id,
            title:     validated.title,
            file:      fileRef,
            // Convenience for the UI; full task is on disk.
            taskPreview: validated.task.slice(0, 240),
        }, { spanId, questId: quest.id, charmId: validated.id });
    }

    return { charm: validated, fileRef };
}

/**
 * Build a single Charm from a Quest. v1 deterministic strategy:
 *   - Charm id = "C01" (one Charm per Quest in v1)
 *   - title    = Quest title
 *   - task     = Quest objective + numbered success criteria the Fairy must
 *                address one-by-one
 *   - deliverables = each successCriterion as one expected output
 *   - constraints  = each Quest risk surfaced as a thing to be mindful of
 */
function buildCharm(quest) {
    const successCriteria = Array.isArray(quest.successCriteria) ? quest.successCriteria : [];
    const risks           = Array.isArray(quest.risks)            ? quest.risks            : [];

    const taskLines = [];
    taskLines.push(quest.objective || '');
    if (successCriteria.length) {
        taskLines.push('');
        taskLines.push('Address each of the following success criteria:');
        successCriteria.forEach((c, i) => taskLines.push(`${i + 1}. ${c}`));
    }
    const task = taskLines.join('\n').trim().slice(0, 8000) || 'Solve the parent Quest.';

    return {
        id:               'C01',
        questId:          quest.id,
        title:            String(quest.title || quest.shortName || quest.id).slice(0, 200),
        task,
        deliverables:     successCriteria.length ? successCriteria.slice(0, 12) : ['A clear answer to the Quest objective'],
        constraints:      risks.slice(0, 12),
        validationChecks: Array.isArray(quest.validationChecks) ? quest.validationChecks.slice(0, 8) : [],
        createdAt:        new Date().toISOString(),
    };
}

async function writeCharm(quest, charm) {
    const root = project.getWorkspaceRoot();
    if (!root) throw new Error('No workspace open; cannot write Charm.');
    const dir = path.join(root, 'quests', require('../memory/quests').questFolderName(quest), 'charms');   // O12: one canonical folder for all quest artifacts
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${charm.id}.json`);
    const json = JSON.stringify(charm, null, 2) + '\n';
    await fsp.writeFile(file, json, 'utf8');
    const sha = 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');
    return { path: file, sha256: sha };
}

// ── Multi-Charm groundwork (Session 17, schema-only) ─────────────────────────
// The data model now supports an array of Charms per Quest. Today the
// deterministic Dispatcher emits exactly one Charm (C01) for backward
// compatibility; future work (Skills system + LLM-driven planner) will
// decompose a Quest into 2-N Charms and run them sequentially. The
// `dispatchCharms` helper persists every Charm in the array and emits one
// `charm.dispatched` event per Charm, ready for downstream loops without
// touching call sites that still call the single-Charm `dispatchCharm`.

/**
 * Build N Charms for a Quest. Default deterministic behaviour returns
 * `[buildCharm(quest)]`. Override `mapper` to decompose a Quest into many
 * Charms.
 *
 * @param {object} quest
 * @param {{ mapper?: (q:object) => object[] }} [opts]
 * @returns {object[]}
 */
function buildCharms(quest, opts) {
    const mapper = opts && typeof opts.mapper === 'function' ? opts.mapper : null;
    if (mapper) return mapper(quest).map((c, i) => ({
        ...c,
        questId:  quest.id,
        id:       c.id || `C${String(i + 1).padStart(2, '0')}`,
        createdAt: c.createdAt || new Date().toISOString(),
    }));
    // When the Planner decomposed the Quest into 2+ independent sub-problems,
    // create one Charm per subtask so each gets its own Fairy run.
    const subtasks = Array.isArray(quest.subtasks) && quest.subtasks.length > 1
        ? quest.subtasks : null;
    if (!subtasks) return [buildCharm(quest)];

    // Per-subtask SCOPING of deliverables and validationChecks.
    // The Planner emits these at QUEST level (covering the whole problem). If
    // we copy the full set onto every Charm, the Critic/Skeptic/Oberon end up
    // judging each Charm against criteria that belong to other Charms (e.g.
    // dinging the Hamiltonian-construction Charm for not producing BAE
    // comparison data). Assign each criterion only to the subtask(s) it
    // actually belongs to, via a symbol/identifier overlap heuristic.
    const questDeliverables = Array.isArray(quest.successCriteria) ? quest.successCriteria : [];
    const questValidations  = Array.isArray(quest.validationChecks) ? quest.validationChecks : [];
    const deliverablesPerSubtask = assignCriteriaPerSubtask(questDeliverables, subtasks);
    const validationsPerSubtask  = assignCriteriaPerSubtask(questValidations,  subtasks);

    const baseTemplate = buildCharm(quest);
    return subtasks.map((task, i) => ({
        ...baseTemplate,
        id:    `C${String(i + 1).padStart(2, '0')}`,
        title: shortenSubtaskForTitle(task) || `${quest.title} (${i + 1}/${subtasks.length})`,
        task,
        // Per-subtask deliverables; fall back to a generic deliverable when
        // none of the quest's success criteria match this subtask's scope.
        deliverables:     deliverablesPerSubtask[i].length
            ? deliverablesPerSubtask[i]
            : ['Complete the specific task above; intermediate outputs do not need to satisfy criteria from other charms.'],
        // Per-subtask validation checks; empty is acceptable when the subtask
        // produces inputs for downstream charms rather than verifiable outputs.
        validationChecks: validationsPerSubtask[i],
    }));
}

// Tokens that are too generic to discriminate between subtasks (Wolfram
// builtins / short letters that appear in almost every criterion).
const _SCOPE_STOPWORDS = new Set([
    'abs', 'sum', 'sin', 'cos', 'tan', 'exp', 'log', 'sqrt',
    'pi', 'mod', 'gcd', 'and', 'not', 'true', 'false', 'with', 'list',
    'sub', 'set', 'get', 'all', 'each', 'any', 'one', 'two', 'three',
]);

/**
 * Extract DISTINCTIVE identifiers from a string: CamelCase symbols (e.g.
 * HermitianMatrixQ) and any token ≥3 chars long, minus a stopword list of
 * common Wolfram builtins. Case-insensitive (returned lowercase).
 */
function _distinctiveTokens(s) {
    const out = new Set();
    const text = String(s || '');
    // CamelCase: starts uppercase + has at least one lowercase letter.
    for (const m of text.matchAll(/\b[A-Z][a-z][A-Za-z0-9]*\b/g)) {
        const t = m[0].toLowerCase();
        if (!_SCOPE_STOPWORDS.has(t)) out.add(t);
    }
    // Any identifier-like token ≥3 chars.
    for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g)) {
        const t = m[0].toLowerCase();
        if (!_SCOPE_STOPWORDS.has(t)) out.add(t);
    }
    return out;
}

/**
 * For each subtask, return the subset of `criteria` that belong to it.
 * Match a criterion's distinctive tokens against subtask text using
 * WORD-BOUNDARY matching (so "tr" matches "Tr[H]" but NOT "spectrum",
 * and "set" matches "set" but not "subset"). Ties (multiple matching
 * subtasks) cause the criterion to be assigned to every subtask whose
 * match score equals the maximum. Criteria with no distinctive tokens
 * are treated as generic and assigned to ALL subtasks (safer than
 * dropping silently).
 */
function assignCriteriaPerSubtask(criteria, subtasks) {
    const perSubtask = subtasks.map(() => []);
    const subtaskLower = subtasks.map(s => String(s || '').toLowerCase());
    const matches = (text, tok) => {
        // Build a word-boundary regex for the token; escape regex specials.
        const safe = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${safe}\\b`).test(text);
    };
    for (const crit of criteria) {
        const distinctive = [..._distinctiveTokens(crit)];
        if (distinctive.length === 0) {
            // Generic check — keep in every subtask.
            perSubtask.forEach(arr => arr.push(crit));
            continue;
        }
        const scores = subtaskLower.map(st =>
            distinctive.reduce((n, t) => n + (matches(st, t) ? 1 : 0), 0));
        const max = Math.max(...scores);
        if (max === 0) continue;   // criterion belongs to no subtask in this Quest → drop
        scores.forEach((s, i) => { if (s === max) perSubtask[i].push(crit); });
    }
    // Cap per-subtask lists at 12 / 8 to satisfy schema limits downstream.
    return perSubtask.map(list => list.slice(0, 12));
}

function shortenSubtaskForTitle(task) {
    const s = String(task || '').trim();
    if (!s) return '';
    // First sentence end, or first 90 chars.
    const dot = s.search(/[.!?](\s|$)/);
    const cut = dot > 10 && dot < 120 ? s.slice(0, dot + 1) : s.slice(0, 90);
    return cut.replace(/\s+/g, ' ').trim() + (s.length > cut.length ? '…' : '');
}

/**
 * Persist + dispatch an array of Charms (one `charm.dispatched` event each).
 * Returns `[{ charm, fileRef }, …]` in the same order.
 *
 * @param {{ quest: object, bus: any, spanId?: string, charms?: object[] }} args
 */
async function dispatchCharms(args) {
    const quest = args && args.quest;
    if (!quest || !quest.id) throw new Error('dispatchCharms: quest is required');
    const list = Array.isArray(args.charms) && args.charms.length
        ? args.charms
        : buildCharms(quest);
    const out = [];
    for (const c of list) {
        const v = validateCharm(c);
        if (!v.ok) {
            const err = new Error(`Dispatcher built an invalid Charm: ${v.errors.join('; ')}`);
            err.kind = 'dispatcher_invalid';
            err.detail = { errors: v.errors, charmId: c && c.id };
            throw err;
        }
        const validated = v.value;
        const fileRef = await writeCharm(quest, validated);
        if (args.bus) {
            await args.bus.appendEvent('charm.dispatched', {
                questId:   quest.id,
                charmId:   validated.id,
                title:     validated.title,
                file:      fileRef,
                taskPreview: validated.task.slice(0, 240),
            }, { spanId: args.spanId, questId: quest.id, charmId: validated.id });
        }
        out.push({ charm: validated, fileRef });
    }
    return out;
}

module.exports = { dispatchCharm, buildCharm, buildCharms, dispatchCharms };
