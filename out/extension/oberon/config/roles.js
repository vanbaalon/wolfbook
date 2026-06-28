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

const ALL_ROLES = ['oberon', 'fairy', 'skeptic', 'postmortem', 'fairy_summariser', 'literature'];

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

    // literature: fast/cheap model for ranking + equation extraction (many calls).
    // Falls back to the summariser/fairy binding with a short output cap.
    if (role === 'literature') {
        const override = settings.roleBinding('literature');
        if (!(override && Object.keys(override).length)) {
            const fairy = resolveRole('fairy');
            return {
                role, provider: fairy.provider, model: fairy.model,
                pricing: fairy.pricing, maxTokens: 800,
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
    if (provider === 'deepseek') return !!settings.deepseekApiKey();
    // Other providers default to "not configured" until adapters land.
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
