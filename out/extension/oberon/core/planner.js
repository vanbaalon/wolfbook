'use strict';
/**
 * Oberon — Planner agent.
 *
 * One LLM call. Brief in → validated Quest out.
 *
 * Emits these events on the supplied TelemetryBus:
 *   llm.call            — full usage + cost + prefix hash + (optional) blob hashes
 *   omen{provider_error}— provider/network failure
 *   omen{schema_repair} — Planner returned malformed JSON; the planner does
 *                        ONE repair retry by appending an error message
 *   quest.accepted      — Planner produced a valid Quest (written to disk)
 *
 * Does NOT emit circle.transition events; the caller (oberon/index.js)
 * is responsible for state machine transitions so the FSM is the single
 * authority on state.
 */

const { getAdapter }        = require('../providers');
const { computeCost }       = require('../providers/cost');
const { buildPlannerPrompt, sha256 } = require('./promptAssembly');
const { validateQuest }     = require('./schemas');
const { makeSpanId }        = require('../telemetry/bus');
const { makeOnChunk }       = require('./llmStream');
const settings              = require('../config/settings');
const roles                 = require('../config/roles');
const questsFs              = require('../memory/quests');

const REPAIR_USER_MSG = (errors) =>
    `Your previous reply was not a valid Quest. Errors:\n${errors.map(e => '- ' + e).join('\n')}\n\nReply again with ONLY a JSON object matching the schema. No prose, no fences.`;

/**
 * @param {{
 *   brief: string,
 *   bus:   import('../telemetry/bus').TelemetryBus,
 *   signal?: AbortSignal,
 *   contextNote?: string,
 * }} args
 * @returns {Promise<{ quest: object, fileRef: {path:string,sha256:string} }>}
 */
async function runPlanner(args) {
    const brief = String(args.brief || '').trim();
    if (!brief) throw new Error('Planner: brief is empty');
    const bus = args.bus;

    const binding = roles.resolveRole('oberon');
    if (!binding.configured) {
        const err = new Error('Oberon role is not configured (provider + model + API key required).');
        err.kind = 'not_configured';
        throw err;
    }

    const adapter = getAdapter(binding.provider);
    const spanId  = makeSpanId();

    const { messages, prefixSha256 } = buildPlannerPrompt({ brief, contextNote: args.contextNote });

    // ── attempt 1 ────────────────────────────────────────────────────────────
    const result1 = await callOnce({
        bus, adapter, binding, messages, signal: args.signal, spanId, prefixSha256,
    });

    let parsed1 = tryParseJson(result1.content);
    let validation = parsed1.ok ? validateQuest(parsed1.value) : { ok: false, errors: [parsed1.error] };

    let quest, fileRef;
    if (validation.ok) {
        quest = validation.value;
    } else {
        // ── one repair turn ──────────────────────────────────────────────────
        await bus.appendEvent('omen', {
            kind: 'schema_repair',
            message: 'Planner output failed Quest validation; attempting one repair turn.',
            detail: { errors: validation.errors, raw: String(result1.content).slice(0, 800) },
        }, { spanId });

        const repairMessages = [
            ...messages,
            { role: 'assistant', content: result1.content },
            { role: 'user',      content: REPAIR_USER_MSG(validation.errors) },
        ];
        const result2 = await callOnce({
            bus, adapter, binding, messages: repairMessages, signal: args.signal, spanId, prefixSha256,
        });
        const parsed2 = tryParseJson(result2.content);
        const v2 = parsed2.ok ? validateQuest(parsed2.value) : { ok: false, errors: [parsed2.error] };
        if (!v2.ok) {
            const err = new Error(`Planner produced invalid Quest after repair: ${v2.errors.join('; ')}`);
            err.kind = 'planner_invalid';
            err.detail = { errors: v2.errors, raw: String(result2.content).slice(0, 800) };
            throw err;
        }
        quest = v2.value;
    }

    // Allocate id if Planner reused a placeholder we already have on disk.
    quest.id = await pickFreeId(quest.id);

    // Deterministic guard (run Q29): snake_case identifiers in validationChecks are
    // WL PATTERNS (exact_energies ≡ Pattern[exact, Blank[energies]]), never definable
    // symbols — such a check fails every run no matter what the agent does. Rewrite
    // them to camelCase; the fairy sees the same sanitised text in its brief, so the
    // expected names stay consistent end-to-end.
    const vcFixes = sanitizeValidationChecks(quest);
    if (vcFixes.length) {
        await bus.appendEvent('omen', {
            kind:    'validation_checks_sanitised',
            message: `Planner wrote ${vcFixes.length} validation check(s) with snake_case identifiers (WL pattern syntax, unsatisfiable) — rewritten to camelCase.`,
            detail:  { fixes: vcFixes },
        }, { spanId, questId: quest.id }).catch(() => {});
    }

    fileRef = await questsFs.writeQuest(quest);

    await bus.appendEvent('quest.accepted', {
        questId: quest.id,
        title:   quest.title,
        shortName: quest.shortName,
        successCriteria: quest.successCriteria,
        file: fileRef,
    }, { spanId, questId: quest.id });

    return { quest, fileRef };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function callOnce({ bus, adapter, binding, messages, signal, spanId, prefixSha256 }) {
    const tel = settings.telemetry();
    // Planning is the highest-leverage judgment call of a run — think at effort
    // high by default (fairy.reasoning.planner: false disables). Verified live
    // (2026-08-01): DeepSeek V4 thinking coexists with response_format
    // json_object (reasoning happens, content is still strict JSON).
    const plannerThinks = settings.fairyReasoning().planner && binding.provider === 'deepseek';
    const req = {
        messages,
        model:          binding.model,
        temperature:    0.2,
        maxTokens:      binding.maxTokens || 8000,
        responseFormat: 'json_object',
        signal,
        thinking:        binding.thinking === true || plannerThinks,
        reasoningEffort: binding.thinking === true
            ? (binding.reasoningEffort || undefined)
            : (plannerThinks ? 'high' : undefined),
    };
    let result;
    try {
        // Stream reasoning/content chunks so the Activity panel can show a
        // live preview during the (often slow) planner call.
        const onChunk = makeOnChunk({ bus, role: 'oberon', spanId });
        result = await adapter.chatComplete(req, { pricing: binding.pricing, onChunk });
    } catch (e) {
        const kind = (e && e.kind) || 'planner_failed';
        await bus.appendEvent('omen', {
            kind,
            message: e && e.message || String(e),
            detail: {
                provider:     binding.provider,
                model:        binding.model,
                status:       e && e.status || null,
                retryAfterMs: e && e.retryAfterMs || null,
            },
        }, { spanId });
        // Tell upstream catch blocks this failure is already in the telemetry —
        // the run_2026-07-03T23-38 log carried the same provider_error twice.
        try { e._omened = true; } catch (_) {}
        throw e;
    }

    // costUSD already computed by adapter when pricing is provided; recompute
    // here as a safety net so the cost path is independent of the adapter.
    const costUSD = (typeof result.costUSD === 'number')
        ? result.costUSD
        : computeCost(result.usage, binding.pricing);

    await bus.appendEvent('llm.call', {
        role:     'oberon',
        provider: result.provider,
        model:    result.model,
        usage:    result.usage,
        costUSD,
        latencyMs: result.latencyMs,
        stopReason: result.stopReason,
        prefixSha256,
        // Full content included for in-session inspection.
        promptMessages: messages,
        responseText:   result.content,
        reasoning:      result.reasoning || null,
        // Raw blob storage gated by user setting; v1 stores hashes only.
        promptBlob:   tel.saveRawPrompts   ? sha256(JSON.stringify(messages))   : null,
        responseBlob: tel.saveRawResponses ? sha256(result.content)             : null,
    }, { spanId });

    return result;
}

/**
 * Rewrite snake_case identifiers in quest.validationChecks to camelCase, in
 * place. In WL `a_b` is Pattern[a, Blank[b]] — it can never hold a value, so a
 * check written with such a "symbol" is unsatisfiable by construction (run Q29:
 * `Length[exact_energies] == 216` disputed a fully verified charm and burned
 * the whole revision budget). Segments after `_` starting with an UPPERCASE
 * letter are left alone — `x_Integer` is intentional pattern syntax. String
 * literals are preserved verbatim.
 * @returns {Array<{ from: string, to: string }>} the rewrites performed
 */
function sanitizeValidationChecks(quest) {
    const fixes = [];
    if (!quest || !Array.isArray(quest.validationChecks)) return fixes;
    const camelize = (expr) => expr.split(/("(?:[^"\\]|\\.)*")/).map((seg, i) => {
        if (i % 2 === 1) return seg;   // inside a string literal
        return seg.replace(/\b([a-zA-Z][A-Za-z0-9]*(?:_[a-z][A-Za-z0-9]*)+)\b/g,
            (m) => m.split('_').map((p, j) => j === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(''));
    }).join('');
    quest.validationChecks = quest.validationChecks.map((expr) => {
        if (typeof expr !== 'string') return expr;
        const fixed = camelize(expr);
        if (fixed !== expr) fixes.push({ from: expr.slice(0, 200), to: fixed.slice(0, 200) });
        return fixed;
    });
    return fixes;
}

function tryParseJson(text) {
    const s = String(text || '').trim();
    // Strip accidental ```json fences if the model added them despite instructions.
    const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return { ok: true, value: JSON.parse(stripped) }; }
    catch (e) { return { ok: false, error: `JSON parse failed: ${e.message}` }; }
}

async function pickFreeId(suggested) {
    const next = await questsFs.nextQuestId();
    // If Planner suggested an id and it's >= next free, keep it (matches user intent).
    const m = /^Q(\d+)/.exec(String(suggested || ''));
    if (m) {
        const n   = parseInt(m[1], 10);
        const mn  = /^Q(\d+)/.exec(next);
        const min = mn ? parseInt(mn[1], 10) : 1;
        return (Number.isFinite(n) && n >= min) ? suggested : next;
    }
    return next;
}

module.exports = { runPlanner, sanitizeValidationChecks };
