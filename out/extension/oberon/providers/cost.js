'use strict';
/**
 * Oberon — cost computation.
 *
 * Pure function: usage + per-million-token pricing → USD.
 *
 * For providers that report cache-hit / cache-miss token counts (e.g. DeepSeek)
 * the input cost is split: cacheMissTokens × cacheMissUSDPerMTok  +
 *                           cacheReadTokens × cacheReadUSDPerMTok.
 * When the breakdown is absent, inputTokens × (cacheMissUSDPerMTok ?? inputUSDPerMTok)
 * is used as a fallback.
 *
 * Pricing fields that are `null` (provider does not report) contribute NOTHING
 * to the total — they are not treated as 0. The UI surface separately renders
 * those as `n/a` so users can see the difference.
 */

/**
 * @param {import('./provider').TokenUsage} usage
 * @param {import('../core/types').RolePricing|null|undefined} pricing
 * @returns {number|null}  total USD, or null when no pricing information was given
 */
function computeCost(usage, pricing) {
    if (!pricing) return null;
    let total = 0;
    let anyKnown = false;

    const u = usage || {};
    const add = (tokens, pricePerMTok) => {
        if (pricePerMTok == null) return;        // n/a → skip
        if (tokens == null) return;              // n/a → skip
        anyKnown = true;
        total += (Number(tokens) / 1e6) * Number(pricePerMTok);
    };

    // Input cost — prefer the per-type breakdown when the provider reports it.
    const hasCacheMiss = u.cacheMissTokens != null;
    const hasCacheHit  = u.cacheReadTokens  != null;
    if (hasCacheMiss || hasCacheHit) {
        // Use cacheMissUSDPerMTok for misses; fall back to inputUSDPerMTok for old configs.
        const missRate = pricing.cacheMissUSDPerMTok != null
            ? pricing.cacheMissUSDPerMTok
            : pricing.inputUSDPerMTok;
        add(u.cacheMissTokens, missRate);
        add(u.cacheReadTokens, pricing.cacheReadUSDPerMTok);
    } else {
        // No breakdown available: treat all input tokens as cache misses.
        const missRate = pricing.cacheMissUSDPerMTok != null
            ? pricing.cacheMissUSDPerMTok
            : pricing.inputUSDPerMTok;
        add(u.inputTokens, missRate);
    }

    add(u.outputTokens,     pricing.outputUSDPerMTok);
    add(u.cacheWriteTokens, pricing.cacheWriteUSDPerMTok);

    return anyKnown ? Number(total.toFixed(8)) : null;
}

module.exports = { computeCost };
