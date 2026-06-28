#!/usr/bin/env node
'use strict';
/**
 * Fairy run metrics — reads a telemetry JSONL and prints a comparable metrics table.
 *
 * Usage:
 *   node out/extension/oberon/tests/benchmarks.js <path-to-run.jsonl>
 *   node out/extension/oberon/tests/benchmarks.js   (uses the most recent run)
 *
 * Output: JSON metrics object + human-readable table.
 * Save the output before and after each implementation stage to track improvements.
 */

const fs   = require('fs');
const path = require('path');

// ── Locate run file ────────────────────────────────────────────────────────────

function findLatestRun() {
    const telDir = path.resolve(__dirname, '../../../../../.oberon/telemetry/runs');
    if (!fs.existsSync(telDir)) {
        console.error('Telemetry directory not found:', telDir);
        process.exit(1);
    }
    const files = fs.readdirSync(telDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    if (!files.length) { console.error('No run files found'); process.exit(1); }
    return path.join(telDir, files[0]);
}

const runFile = process.argv[2]
    ? path.resolve(process.argv[2])
    : findLatestRun();

if (!fs.existsSync(runFile)) {
    console.error('File not found:', runFile);
    process.exit(1);
}

const events = fs.readFileSync(runFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);

// ── Extract events ─────────────────────────────────────────────────────────────

const llmEvents   = events.filter(e => e.type === 'llm.call');
const toolEvents  = events.filter(e => e.type === 'tool.call');
const corrEvents  = events.filter(e => e.type === 'correlated.tool');
const scrollEvent = events.find(e => e.type === 'scroll.submitted');
const consFailEvents = events.filter(e => e.type === 'fairy.consecutive_failures');

const fairyLlm = llmEvents.filter(e => (e.payload || {}).role === 'fairy');

// ── Token metrics ──────────────────────────────────────────────────────────────

const totalIn   = fairyLlm.reduce((s, e) => s + (e.payload.usage.inputTokens   || 0), 0);
const totalOut  = fairyLlm.reduce((s, e) => s + (e.payload.usage.outputTokens  || 0), 0);
const totalMiss = fairyLlm.reduce((s, e) => s + (e.payload.usage.cacheMissTokens || 0), 0);
const totalHit  = fairyLlm.reduce((s, e) => s + (e.payload.usage.cacheReadTokens || 0), 0);
const totalCost = llmEvents.reduce((s, e) => s + ((e.payload || {}).costUSD || 0), 0);

const peakInput = Math.max(...fairyLlm.map(e => e.payload.usage.inputTokens || 0), 0);

const cacheHitRatio = (totalHit + totalMiss) > 0
    ? totalHit / (totalHit + totalMiss)
    : 0;

// Per-turn cache hit ratios
const perTurnHitRatio = fairyLlm.map(e => {
    const hit  = e.payload.usage.cacheReadTokens || 0;
    const miss = e.payload.usage.cacheMissTokens || 0;
    return (hit + miss) > 0 ? hit / (hit + miss) : 0;
});
const minCacheHit = Math.min(...perTurnHitRatio);
const avgCacheHit = perTurnHitRatio.reduce((s, v) => s + v, 0) / (perTurnHitRatio.length || 1);

// ── Tool usage breakdown ───────────────────────────────────────────────────────

function countTool(name) {
    return toolEvents.filter(e => (e.payload || {}).name === name).length;
}
function countCorrTool(name, ok) {
    return corrEvents.filter(e => {
        const p = e.payload || {};
        return p.name === name && (ok === undefined || p.ok === ok);
    }).length;
}

const totalProbes    = countCorrTool('probe');
const failedProbes   = countCorrTool('probe', false);
const successProbes  = countCorrTool('probe', true);
const recordCalls    = countTool('record');
const chainCalls     = countTool('chain');
const inspectCalls   = countTool('inspect');
const lookupCalls    = countTool('lookup');

// ── Probe result payload sizes (how big are tool results in message history) ───
// Reconstruct from llm.call promptMessages — look at tool-role messages

const toolMsgSizes = [];
for (const e of fairyLlm) {
    for (const m of (e.payload.promptMessages || [])) {
        if (m.role === 'tool') {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            try {
                const parsed = JSON.parse(content);
                // Only count probe results
                if (parsed && parsed.probeId) {
                    toolMsgSizes.push(content.length);
                }
            } catch (_) {}
        }
    }
}
const avgProbePayload = toolMsgSizes.length > 0
    ? Math.round(toolMsgSizes.reduce((s, v) => s + v, 0) / toolMsgSizes.length)
    : 0;
const maxProbePayload = toolMsgSizes.length > 0 ? Math.max(...toolMsgSizes) : 0;

// ── Consecutive failure runs ───────────────────────────────────────────────────

// Find max run of consecutive failed probes from correlated.tool events
let maxConsecutiveFail = 0, curConsecutive = 0;
for (const e of corrEvents) {
    if ((e.payload || {}).name === 'probe') {
        if (!e.payload.ok) {
            curConsecutive++;
            maxConsecutiveFail = Math.max(maxConsecutiveFail, curConsecutive);
        } else {
            curConsecutive = 0;
        }
    }
}
const consecutiveFailureInterventions = consFailEvents.length;

// ── Tool spec size ─────────────────────────────────────────────────────────────
// Estimate from the first fairy LLM call's tool definitions
let toolSpecTokenEstimate = null;
if (fairyLlm.length > 0) {
    // Tools are sent in the API call — not in promptMessages but in tool_choice.
    // Approximate from system prompt length change vs a no-tools call.
    // Instead, check the system message length at turn 1 vs turn 2 to estimate stability.
    const firstMsgs = (fairyLlm[0].payload.promptMessages || []);
    const systemMsg = firstMsgs.find(m => m.role === 'system');
    if (systemMsg) {
        toolSpecTokenEstimate = Math.round(
            (typeof systemMsg.content === 'string' ? systemMsg.content.length : 0) / 4
        );
    }
}

// ── Scroll outcome ─────────────────────────────────────────────────────────────

const scrollStatus = scrollEvent ? (scrollEvent.payload || {}).status   : 'unknown';
const scrollSteps  = scrollEvent ? ((scrollEvent.payload || {}).steps || []).length : 0;

// ── Run ID ────────────────────────────────────────────────────────────────────

const runId = path.basename(runFile, '.jsonl');

// ── Output ────────────────────────────────────────────────────────────────────

const metrics = {
    runId,
    // Turns & cost
    fairyTurns:    fairyLlm.length,
    totalLlmCalls: llmEvents.length,
    totalToolCalls: toolEvents.length,
    totalCostUSD:  parseFloat(totalCost.toFixed(5)),

    // Token counts
    totalInputTokens:  totalIn,
    totalOutputTokens: totalOut,
    peakInputTokens:   peakInput,

    // Cache
    cacheHitRatioOverall: parseFloat(cacheHitRatio.toFixed(3)),
    cacheHitRatioMin:     parseFloat(minCacheHit.toFixed(3)),
    cacheHitRatioAvg:     parseFloat(avgCacheHit.toFixed(3)),

    // Probes
    totalProbes,
    successProbes,
    failedProbes,
    probeFailureRate: totalProbes > 0 ? parseFloat((failedProbes / totalProbes).toFixed(3)) : 0,

    // Other tools
    recordCalls,
    chainCalls,
    inspectCalls,
    lookupCalls,

    // Payload sizes in history (key Stage 1 metric)
    avgProbePayloadChars: avgProbePayload,
    maxProbePayloadChars: maxProbePayload,

    // Consecutive failures
    maxConsecutiveFailures:         maxConsecutiveFail,
    consecutiveFailureInterventions,

    // System prompt estimate
    systemPromptTokenEstimate: toolSpecTokenEstimate,

    // Outcome
    scrollStatus,
    scrollSteps,
};

// Human-readable table
const col1 = 38, col2 = 20;
function row(label, value, target) {
    const v = String(value).padEnd(col2);
    const t = target !== undefined ? `  ← target: ${target}` : '';
    console.log('  ' + label.padEnd(col1) + v + t);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Fairy Run Metrics — ${runId}`);
console.log('══════════════════════════════════════════════════════════');
console.log('\n  ── Turns & Cost ──');
row('Fairy LLM turns',           metrics.fairyTurns);
row('Total LLM calls (all)',      metrics.totalLlmCalls);
row('Total tool calls',           metrics.totalToolCalls);
row('Total cost USD',             `$${metrics.totalCostUSD.toFixed(4)}`,    '< $0.040');

console.log('\n  ── Token Usage ──');
row('Total fairy input tokens',   metrics.totalInputTokens,    '< 500,000');
row('Total fairy output tokens',  metrics.totalOutputTokens);
row('Peak input tokens (1 turn)', metrics.peakInputTokens,     '< 25,000');

console.log('\n  ── Cache ──');
row('Cache hit ratio (overall)',  (metrics.cacheHitRatioOverall * 100).toFixed(1) + '%',  '> 80%');
row('Cache hit ratio (min/turn)', (metrics.cacheHitRatioMin     * 100).toFixed(1) + '%',  '> 60%');
row('Cache hit ratio (avg/turn)', (metrics.cacheHitRatioAvg     * 100).toFixed(1) + '%',  '> 80%');

console.log('\n  ── Probes ──');
row('Total probes',               metrics.totalProbes);
row('Successful probes',          metrics.successProbes);
row('Failed probes',              metrics.failedProbes);
row('Probe failure rate',         (metrics.probeFailureRate * 100).toFixed(1) + '%',       '< 25%');

console.log('\n  ── Other Tools ──');
row('record calls',               metrics.recordCalls);
row('chain calls',                metrics.chainCalls);
row('inspect calls',              metrics.inspectCalls);
row('lookup calls',               metrics.lookupCalls);

console.log('\n  ── Stage 1 Key Metrics ──');
row('Avg probe payload (chars)',  metrics.avgProbePayloadChars,  '< 600');
row('Max probe payload (chars)',  metrics.maxProbePayloadChars,  '< 800');
row('Max consecutive failures',  metrics.maxConsecutiveFailures, '≤ 3');
row('Failure interventions fired', metrics.consecutiveFailureInterventions);
row('System prompt tokens (est.)', metrics.systemPromptTokenEstimate);

console.log('\n  ── Outcome ──');
row('Scroll status',              metrics.scrollStatus);
row('Recorded steps',             metrics.scrollSteps);
console.log('══════════════════════════════════════════════════════════\n');

// Also output raw JSON for scripted comparison
if (process.argv.includes('--json')) {
    console.log(JSON.stringify(metrics, null, 2));
}
