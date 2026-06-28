'use strict';
/**
 * Oberon — shared JSDoc typedefs.
 *
 * No runtime exports; this file exists so other modules can `@typedef import`.
 * Schemas live alongside in core/schemas/*.json (added in MVP-1+).
 *
 * @typedef {(
 *   'IDLE' | 'BRIEFING' | 'QUEST_DEFINED' | 'CHARM_DISPATCHED' |
 *   'FAIRY_WORKING' | 'SCROLL_SUBMITTED' | 'REVIEWING' |
 *   'WARDS_REQUESTED' | 'DECISION' | 'GRIMOIRE_UPDATED' | 'ABORTED' | 'ERROR'
 * )} CircleState
 *
 * @typedef {(
 *   'oberon' | 'fairy' | 'skeptic' | 'postmortem'
 * )} RoleKey
 *
 * @typedef {Object} TaskBudget
 * @property {number} maxLlmCalls
 * @property {number} maxToolCalls
 * @property {number} maxOutputTokens
 * @property {number} maxWallClockMs
 *
 * @typedef {Object} RolePricing
 * @property {number|null} inputUSDPerMTok       // fallback for providers without cache breakdown
 * @property {number|null} cacheMissUSDPerMTok   // cache-miss input rate (preferred over inputUSDPerMTok)
 * @property {number|null} cacheReadUSDPerMTok   // cache-hit input rate
 * @property {number|null} cacheWriteUSDPerMTok  // cache-write/store rate
 * @property {number|null} outputUSDPerMTok
 *
 * @typedef {Object} RoleBinding
 * @property {string} provider                  // 'deepseek' | 'anthropic' | 'openai' | 'lmapi'
 * @property {string} model
 * @property {RolePricing} pricing
 *
 * @typedef {Object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number|null} cacheReadTokens     // null = provider does not report
 * @property {number|null} cacheWriteTokens
 *
 * @typedef {Object} RunSummary
 * @property {string} runId                     // run_<ISO timestamp>
 * @property {string} startedAt
 * @property {string|null} endedAt
 * @property {CircleState} state
 * @property {string|null} questId
 * @property {string|null} charmId
 * @property {number} eventCount
 * @property {number} llmCallCount
 * @property {number} totalCostUSD
 * @property {TokenUsage} totalUsage
 *
 * @typedef {Object} TelemetryEvent
 * @property {string} eventId
 * @property {string} runId
 * @property {string} ts                        // ISO 8601 with ms
 * @property {string|null} spanId
 * @property {string|null} parentSpanId
 * @property {string|null} correlationId
 * @property {string|null} questId
 * @property {string|null} charmId
 * @property {string} type
 * @property {any} payload
 *
 * @typedef {Object} OmenPayload
 * @property {string} kind                      // 'schema_repair' | 'guard_block' | 'budget_exhausted' | 'provider_error' | …
 * @property {string} message
 * @property {any}    [detail]
 */

module.exports = Object.freeze({});
