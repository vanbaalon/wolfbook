'use strict';
/**
 * Oberon — Executive analysis (P-9).
 *
 * One LLM call invoked AFTER a Charm finishes with a non-success Skeptic
 * verdict, budget exhaustion, or a fallback Scroll. Produces a structured
 * decision: which facts to bank, what to do next, and any follow-up briefs
 * to feed back into the Planner.
 *
 * This module is INTENTIONALLY independent of the multi-charm orchestration
 * — it only analyses and recommends. The caller (typically `oberon/index.js`)
 * is responsible for executing the recommendation.
 */

const { getAdapter }              = require('../providers');
const { computeCost }             = require('../providers/cost');
const { sha256 }                  = require('./promptAssembly');
const { makeSpanId }              = require('../telemetry/bus');
const settings                    = require('../config/settings');
const roles                       = require('../config/roles');
const facts                       = require('../memory/establishedFacts');
const grimoire                    = require('../memory/grimoire');
const { SYSTEM_PROMPT }           = require('../agents/oberonExecutive.prompt');

/**
 * @param {{
 *   quest:       object,
 *   charm:       object,
 *   scroll:      object,
 *   reviewOut:   object|null,         // { skeptic, oberonVerdict, revisionsUsed, ... }
 *   budgetInfo:  { budgetExhausted: boolean, llmCalls?: number, toolCalls?: number }|null,
 *   bus:         any,
 *   signal:      AbortSignal|null,
 * }} args
 *
 * @returns {Promise<{
 *   action:           'decompose_further'|'retry_subset'|'extract_and_continue'|'reformulate_brief'|'escalate'|'skipped',
 *   diagnosis:        string,
 *   followUpBriefs:   string[],
 *   factsWritten:     number,
 *   rationale:        string,
 *   skipped?:         boolean,
 *   reason?:          string,
 * }>}
 */
async function runExecutiveAnalysis(args) {
    const { quest, charm, scroll, reviewOut, cleanNotebook, budgetInfo, bus, signal } = args;
    const spanId = makeSpanId('exec');

    // If the Oberon role is unconfigured we cannot run the LLM — bail.
    const binding = roles.resolveRole('oberon');
    if (!binding || !binding.provider || !binding.model) {
        await _omen(bus, spanId, quest, charm, 'executive_unconfigured',
            'Oberon role unconfigured — skipping executive analysis.');
        return { action: 'skipped', diagnosis: 'Oberon role unconfigured.', followUpBriefs: [], factsWritten: 0, rationale: '', skipped: true, reason: 'role_unconfigured' };
    }

    const adapter = getAdapter(binding.provider);
    // Stage-4 S4.6: include recent Grimoire entries so follow-up briefs
    // build on canonical state instead of repeating work.
    let grimoireSnippet = '';
    try { grimoireSnippet = await grimoire.recentEntriesSummary({ limit: 4, maxChars: 1600 }); }
    catch (_) { /* best-effort */ }
    const userPayload = _buildUserPayload({ quest, charm, scroll, reviewOut, cleanNotebook, budgetInfo, priorFacts: await facts.readFacts({ quest }), grimoireSnippet });
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPayload },
    ];
    const prefixSha256 = sha256(SYSTEM_PROMPT);

    await bus.appendEvent('executive.requested', {
        questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
        reason: budgetInfo && budgetInfo.budgetExhausted ? 'budget_exhausted'
            : (reviewOut && reviewOut.skeptic && reviewOut.skeptic.verdict) || 'unknown',
    }, { spanId, questId: quest.id, charmId: charm.id });

    let result;
    try {
        result = await adapter.chatComplete({
            messages,
            model:          binding.model,
            temperature:    0.2,
            maxTokens:      binding.maxTokens || 4000,
            responseFormat: 'json_object',
            signal,
        }, { pricing: binding.pricing });
    } catch (e) {
        await _omen(bus, spanId, quest, charm, 'executive_provider_error',
            `Executive LLM call failed: ${e && e.message || String(e)}`);
        return { action: 'skipped', diagnosis: 'Provider error.', followUpBriefs: [], factsWritten: 0, rationale: '', skipped: true, reason: 'provider_error' };
    }

    const costUSD = (typeof result.costUSD === 'number') ? result.costUSD : computeCost(result.usage, binding.pricing);
    try {
        await bus.appendEvent('llm.call', {
            role:     'oberon_executive',
            provider: result.provider,
            model:    result.model,
            usage:    result.usage,
            costUSD,
            latencyMs: result.latencyMs,
            stopReason: result.stopReason,
            prefixSha256,
            promptMessages: messages,
            responseText:   result.content,
            reasoning:      result.reasoning || null,
        }, { spanId, questId: quest.id, charmId: charm.id });
    } catch (_) {}

    let parsed;
    try { parsed = JSON.parse(String(result.content || '').trim()); }
    catch (e) {
        await _omen(bus, spanId, quest, charm, 'executive_parse_error',
            `Executive JSON parse failed: ${e && e.message || String(e)}`);
        return { action: 'skipped', diagnosis: 'Bad JSON.', followUpBriefs: [], factsWritten: 0, rationale: '', skipped: true, reason: 'parse_error' };
    }

    const action = ['decompose_further','retry_subset','extract_and_continue','reformulate_brief','escalate']
        .includes(parsed.action) ? parsed.action : 'escalate';
    const diagnosis = String(parsed.diagnosis || '').slice(0, 2000);
    const rationale = String(parsed.rationale || '').slice(0, 1000);
    const followUpBriefs = Array.isArray(parsed.followUpBriefs)
        ? parsed.followUpBriefs.map(s => String(s || '').trim()).filter(Boolean).slice(0, 4)
        : [];

    // Persist proposed facts (each as its own .json under quests/<qid>/facts/).
    let factsWritten = 0;
    const factsToEstablish = Array.isArray(parsed.factsToEstablish) ? parsed.factsToEstablish.slice(0, 8) : [];
    for (const f of factsToEstablish) {
        if (!f || !f.claim) continue;
        const rec = await facts.writeFact({
            quest,
            sourceCharmId:  charm.id,
            sourceScrollId: scroll && scroll.id,
            verified:       false,   // executive-extracted facts are not Skeptic-verified
            confidence:     typeof f.confidence === 'number' ? f.confidence : 0.5,
            claim:          f.claim,
            details:        f.details || '',
            evidence:       Array.isArray(f.evidence) ? f.evidence : [],
            extractedBy:    'oberon_executive',
            bus,
        });
        if (rec) factsWritten++;
    }

    await bus.appendEvent('executive.decided', {
        questId: quest.id, charmId: charm.id,
        action, factsWritten,
        followUpBriefsCount: followUpBriefs.length,
        diagnosisPreview: diagnosis.slice(0, 240),
    }, { spanId, questId: quest.id, charmId: charm.id });

    return { action, diagnosis, followUpBriefs, factsWritten, rationale };
}

// ── helpers ────────────────────────────────────────────────────────────────

function _buildUserPayload({ quest, charm, scroll, reviewOut, cleanNotebook, budgetInfo, priorFacts, grimoireSnippet }) {
    const findings = Array.isArray(scroll && scroll.findings) ? scroll.findings : [];
    const openQs   = Array.isArray(scroll && scroll.openQuestions) ? scroll.openQuestions : [];

    const payload = {
        quest: {
            id:               quest.id,
            title:            quest.title || quest.shortName,
            objective:        quest.objective || quest.brief || '',
            successCriteria:  quest.successCriteria || [],
            subtasks:         quest.subtasks || null,
        },
        charm: {
            id:                charm.id,
            title:             charm.title,
            task:              String(charm.task || '').slice(0, 1500),
            deliverables:      charm.deliverables || [],
            validationChecks:  charm.validationChecks || [],
        },
        scroll: scroll ? {
            id:           scroll.id,
            summary:      scroll.summary || '',
            confidence:   scroll.confidence,
            findings:     findings.slice(0, 12),
            openQuestions: openQs.slice(0, 8),
            fallback:     !!scroll.fallback,
        } : null,
        // Verification is the Fairy's clean.wb run (fresh-kernel replay). The
        // digest below is the actual per-cell code + output of that run — reason
        // from what really executed, not from a critic's objections.
        verdict: (reviewOut && reviewOut.oberonVerdict && reviewOut.oberonVerdict.verdict) || null,
        cleanNotebook: cleanNotebook ? String(cleanNotebook).slice(0, 4000) : null,
        budget: budgetInfo || null,
        priorFacts: (priorFacts || []).map(f => ({
            id: f.id, claim: f.claim, confidence: f.confidence, verified: f.verified,
            sourceCharmId: f.sourceCharmId,
        })),
    };

    return [
        'Analyse the outcome of the Charm below and produce your JSON decision.',
        grimoireSnippet ? '\n' + grimoireSnippet.trim() + '\n' : '',
        '',
        '```json',
        JSON.stringify(payload, null, 2),
        '```',
    ].filter(s => s !== '').join('\n');
}

async function _omen(bus, spanId, quest, charm, kind, message) {
    try {
        await bus.appendEvent('omen', { kind, message },
            { spanId, questId: quest && quest.id, charmId: charm && charm.id });
    } catch (_) {}
}

module.exports = { runExecutiveAnalysis };
