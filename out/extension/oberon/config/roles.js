'use strict';
/**
 * Oberon — role bindings.
 *
 * Resolves the (provider, model, pricing) tuple for each role, falling back
 * to the `fairy` role when an override role is empty. Adds a `configured`
 * flag callers can use to gate UI affordances.
 */
const settings = require('./settings');

/** @typedef {import('../core/types')} _types */

const ALL_ROLES = ['oberon', 'fairy', 'postmortem', 'fairy_summariser', 'literature', 'director'];

/**
 * @param {string} role
 * @returns {{ role: string, provider: string, model: string, pricing: any, configured: boolean }}
 */
function resolveRole(role) {
    // fairy_summariser: cheap compaction model. Falls back to fairy's binding
    // with a short output cap (500 tokens). Can be overridden via VS Code settings
    // like any other role.
    if (role === 'fairy_summariser') {
        const override = settings.roleBinding('fairy_summariser');
        if (override && Object.keys(override).length) {
            // user has explicitly configured the summariser role — use it
        } else {
            const fairy = resolveRole('fairy');
            return {
                role, provider: fairy.provider, model: fairy.model,
                pricing: fairy.pricing, maxTokens: 500,
                contextWindow: fairy.contextWindow, configured: fairy.configured,
            };
        }
    }

    // director: the planning/analysis layer ABOVE the fairy (Oberon Director).
    // Falls back to the oberon binding — the strongest configured planner model.
    // Override via wolfbook.oberon.roles.director to pin a stronger/cheaper model.
    if (role === 'director') {
        const override = settings.roleBinding('director');
        if (!(override && Object.keys(override).length)) {
            const oberon = resolveRole('oberon');
            return {
                role, provider: oberon.provider, model: oberon.model,
                pricing: oberon.pricing, maxTokens: oberon.maxTokens,
                contextWindow: oberon.contextWindow, configured: oberon.configured,
            };
        }
    }

    // literature: fast/cheap model for ranking + equation extraction (many calls).
    // Falls back to the summariser/fairy binding. R8: cap raised 800 → 2000 —
    // run Q_42CQ3G showed DeepSeek's plan/reformulate JSON replies truncating at
    // exactly 800 output tokens, silently degrading the whole search pipeline
    // (fallback plan, dead rescue round).
    if (role === 'literature') {
        const override = settings.roleBinding('literature');
        if (!(override && Object.keys(override).length)) {
            const fairy = resolveRole('fairy');
            return {
                role, provider: fairy.provider, model: fairy.model,
                pricing: fairy.pricing, maxTokens: 2000,
                contextWindow: fairy.contextWindow, configured: fairy.configured,
            };
        }
    }

    const binding = settings.roleBinding(role) || {};
    const provider     = String(binding.provider     || '');
    const model        = String(binding.model        || '');
    const pricing      = binding.pricing || {
        inputUSDPerMTok:     null,
        cacheMissUSDPerMTok: null,
        cacheReadUSDPerMTok: null,
        cacheWriteUSDPerMTok: null,
        outputUSDPerMTok:    null,
    };
    const maxTokens    = Number(binding.maxTokens    || 0) || null;   // null = use call-site default
    const contextWindow= Number(binding.contextWindow|| 0) || null;   // null = unknown
    const configured = providerConfigured(provider) && !!model;
    return { role, provider, model, pricing, maxTokens, contextWindow, configured };
}

function providerConfigured(provider) {
    if (!provider) return false;
    if (provider === 'deepseek')  return !!settings.deepseekApiKey();
    // O1: the anthropic/openai adapters are complete (tool mapping, retries,
    // prompt caching) — a role binds to them as soon as an API key is present.
    if (provider === 'anthropic') return !!settings.anthropicApiKey();
    if (provider === 'openai')    return !!settings.openaiApiKey();
    return false;
}

/** @returns {Array<{role:string,provider:string,model:string,pricing:any,configured:boolean}>} */
function resolveAllRoles() {
    return ALL_ROLES.map(resolveRole);
}

/**
 * Are at least the two minimum roles (oberon + fairy) ready to run?
 */
function minimallyConfigured() {
    return resolveRole('oberon').configured && resolveRole('fairy').configured;
}

module.exports = { ALL_ROLES, resolveRole, resolveAllRoles, minimallyConfigured, providerConfigured };
