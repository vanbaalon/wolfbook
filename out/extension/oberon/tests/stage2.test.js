#!/usr/bin/env node
'use strict';
/**
 * Stage 2 implementation tests.
 *
 * Covers:
 *   2A — appendToLastToolOrUser: budget reminder and consecutive-failure hints
 *        appended to last tool/user message instead of pushing a new user message
 *   2B — collapseFailed: failed probe pairs collapsed to one-liner
 *        compactMessages: keeps head+tail, inserts digest, skips when short
 *        buildCompactionPrompt: output structure
 *        fairy_summariser role: resolves via fairy fallback
 *
 * Run: node out/extension/oberon/tests/stage2.test.js
 * No real Wolfram kernel or network required.
 */

const assert = require('assert');
const path   = require('path');
const os     = require('os');
const fsp    = require('fs/promises');

// ── Stub vscode ───────────────────────────────────────────────────────────────
const Module = require('module');
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode2.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            workspaceFolders: [],
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration: () => ({ get: () => undefined }),
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showWarningMessage:     () => Promise.resolve(),
            showErrorMessage:       () => Promise.resolve(),
        },
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
        EventEmitter: class {
            constructor() { this.event = () => ({ dispose() {} }); }
            fire() {} dispose() {}
        },
    },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

// ── Stub wolframShim ──────────────────────────────────────────────────────────
{
    const shimPath = require.resolve('../core/wolframShim');
    if (!require.cache[shimPath]) {
        require.cache[shimPath] = {
            id: shimPath, filename: shimPath, loaded: true,
            exports: {
                DEFAULT_TIMEOUT: 30, MAX_TIMEOUT: 120,
                async evalOnce() { return { ok: true, kind: 'ok', value: '42', messages: null, prints: null, durationMs: 1 }; },
            },
        };
    }
}

// ── Load modules ──────────────────────────────────────────────────────────────
const { _internals } = require('../core/fairy');
const { appendToLastToolOrUser, collapseFailed, compactMessages } = _internals;

const { buildCompactionPrompt } = require('../fairy/prompts');
const roles = require('../config/roles');

// ── Test harness ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];

async function t(name, fn) {
    try {
        await fn();
        console.log('  ok', name);
        pass++;
    } catch (e) {
        console.error('  FAIL', name);
        console.error('    ', e.message || e);
        failures.push({ name, error: e.message || String(e) });
        fail++;
    }
}
function eq(a, b, msg)  { assert.deepStrictEqual(a, b, msg); }
function ok(v, msg)     { assert.ok(v, msg); }
function notOk(v, msg)  { assert.ok(!v, msg); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToolMsg(content, id, turnIndex) {
    const m = { role: 'tool', tool_call_id: id || 'tc1', content: JSON.stringify(content) };
    if (turnIndex != null) m._turnIndex = turnIndex;
    return m;
}

function makeAssistantCall(toolName, args, id) {
    return {
        role: 'assistant', content: '',
        tool_calls: [{ id: id || 'tc1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args || {}) } }],
    };
}

(async () => {

// ══════════════════════════════════════════════════════════════════════════════
// 2A — appendToLastToolOrUser
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 2A: appendToLastToolOrUser --');

await t('2A: appends to last tool message when present', () => {
    const msgs = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'task' },
        makeAssistantCall('probe', { code: '1+1', note: 'test' }),
        makeToolMsg({ probeId: 'p001', ok: true, resultPreview: '2' }),
    ];
    appendToLastToolOrUser(msgs, 'BUDGET WARNING');
    const last = msgs[msgs.length - 1];
    eq(last.role, 'tool', 'last message should still be tool');
    ok(last.content.includes('BUDGET WARNING'), 'budget warning should be in tool message content');
    eq(msgs.length, 4, 'should not push a new message');
});

await t('2A: does not disturb system message (never appends to it)', () => {
    const msgs = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'task' },
    ];
    appendToLastToolOrUser(msgs, 'hint');
    // Should append to the user message (last user/tool)
    eq(msgs[msgs.length - 1].role, 'user', 'should append to user when no tool');
    ok(msgs[msgs.length - 1].content.includes('hint'));
    notOk(msgs[0].content.includes('hint'), 'system message must not be touched');
    eq(msgs.length, 2, 'should not push a new message');
});

await t('2A: falls back to pushing new user message when no tool/user exists', () => {
    const msgs = [
        { role: 'system', content: 'system' },
        { role: 'assistant', content: 'thinking' },
    ];
    appendToLastToolOrUser(msgs, 'fallback');
    eq(msgs.length, 3, 'should push new message as fallback');
    eq(msgs[2], { role: 'user', content: 'fallback' });
});

await t('2A: prefers last tool over earlier user message', () => {
    const msgs = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'task' },
        makeAssistantCall('probe', {}),
        makeToolMsg({ probeId: 'p001', ok: false, error: 'oops' }),
        makeAssistantCall('lookup', {}),
        makeToolMsg({ ok: true, result: 'docs' }),
    ];
    const originalUserContent = msgs[1].content;
    appendToLastToolOrUser(msgs, 'NUDGE');
    eq(msgs[1].content, originalUserContent, 'user message should be untouched');
    ok(msgs[msgs.length - 1].content.includes('NUDGE'), 'last tool message should have the nudge');
    eq(msgs.length, 6, 'should not change message count');
});

await t('2A: multiple appends accumulate in the same last message', () => {
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        makeToolMsg({ probeId: 'p001', ok: true, resultPreview: '5' }),
    ];
    appendToLastToolOrUser(msgs, 'HINT_A');
    appendToLastToolOrUser(msgs, 'HINT_B');
    const last = msgs[msgs.length - 1];
    ok(last.content.includes('HINT_A'), 'first hint present');
    ok(last.content.includes('HINT_B'), 'second hint present');
    eq(msgs.length, 3, 'count unchanged after two appends');
});

await t('2A: budget reminder ends up in last tool message (simulated flow)', () => {
    // Simulate the actual flow: system + task user msg + several probe turns
    const msgs = [
        { role: 'system', content: 'SYSTEM_PROMPT' },
        { role: 'user', content: 'task description' },
    ];
    // Simulate 2 turns of probe
    for (let i = 0; i < 2; i++) {
        msgs.push(makeAssistantCall('probe', { code: 'x', note: 'n' }, `tc${i}`));
        msgs.push(makeToolMsg({ probeId: `p00${i+1}`, ok: true, resultPreview: String(i) }, `tc${i}`, i + 1));
    }
    const initialLength = msgs.length;
    appendToLastToolOrUser(msgs, 'BUDGET_REMINDER');

    eq(msgs.length, initialLength, 'no new message pushed');
    eq(msgs[msgs.length - 1].role, 'tool', 'last is still tool');
    ok(msgs[msgs.length - 1].content.includes('BUDGET_REMINDER'));
    // system and user must be untouched
    eq(msgs[0].content, 'SYSTEM_PROMPT');
    eq(msgs[1].content, 'task description');
});

await t('2A: consecutive failure nudge ends up in last tool message', () => {
    const msgs = [
        { role: 'system', content: 'SYSTEM_PROMPT' },
        { role: 'user', content: 'task' },
        makeAssistantCall('probe', { code: 'bad(', note: 'test' }, 'tc1'),
        makeToolMsg({ probeId: 'p001', ok: false, error: 'syntax error' }, 'tc1', 1),
        makeAssistantCall('probe', { code: 'bad(', note: 'test2' }, 'tc2'),
        makeToolMsg({ probeId: 'p002', ok: false, error: 'syntax error' }, 'tc2', 2),
        makeAssistantCall('probe', { code: 'bad(', note: 'test3' }, 'tc3'),
        makeToolMsg({ probeId: 'p003', ok: false, error: 'syntax error' }, 'tc3', 3),
    ];
    const initialLength = msgs.length;
    appendToLastToolOrUser(msgs, '[System: 3 consecutive probe failures.]');

    eq(msgs.length, initialLength, 'no new user message pushed');
    ok(msgs[msgs.length - 1].content.includes('[System: 3 consecutive'));
});

// ══════════════════════════════════════════════════════════════════════════════
// 2B — collapseFailed
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 2B: collapseFailed --');

await t('2B: collapses failed probe pair to single user message', () => {
    const msgs = [
        makeAssistantCall('probe', { code: 'bad(', note: 'test' }, 'tc1'),
        makeToolMsg({ probeId: 'p001', ok: false, error: 'syntax error in bad(' }, 'tc1'),
    ];
    const result = collapseFailed(msgs);
    eq(result.length, 1, 'failed pair -> 1 collapsed message');
    eq(result[0].role, 'user');
    ok(result[0].content.includes('p001'), 'probe id in collapsed');
    ok(result[0].content.includes('FAILED'), 'FAILED marker present');
    ok(result[0].content.includes('syntax error'), 'error snippet present');
});

await t('2B: leaves successful probe pair intact', () => {
    const msgs = [
        makeAssistantCall('probe', { code: '1+1', note: 'test' }, 'tc1'),
        makeToolMsg({ probeId: 'p001', ok: true, resultPreview: '2' }, 'tc1'),
    ];
    const result = collapseFailed(msgs);
    eq(result.length, 2, 'successful pair kept as-is');
    eq(result[0].role, 'assistant');
    eq(result[1].role, 'tool');
});

await t('2B: collapses only failed pairs, preserves successful ones', () => {
    const msgs = [
        makeAssistantCall('probe', { code: 'ok_code', note: 'ok' }, 'tc1'),
        makeToolMsg({ probeId: 'p001', ok: true, resultPreview: '42' }, 'tc1'),
        makeAssistantCall('probe', { code: 'bad(', note: 'fail' }, 'tc2'),
        makeToolMsg({ probeId: 'p002', ok: false, error: 'SyntaxError' }, 'tc2'),
        makeAssistantCall('record', { stepId: 's1', description: 'answer is 42' }, 'tc3'),
        makeToolMsg({ stepId: 's1', ok: true }, 'tc3'),
    ];
    const result = collapseFailed(msgs);
    eq(result.length, 5, 'ok pair (2) + collapsed fail (1) + record pair (2) = 5');
    eq(result[0].role, 'assistant');
    eq(result[1].role, 'tool');
    eq(result[2].role, 'user');
    ok(result[2].content.includes('FAILED'));
    eq(result[3].role, 'assistant');
    eq(result[4].role, 'tool');
});

await t('2B: non-probe failed tool not collapsed', () => {
    const msgs = [
        makeAssistantCall('record', { stepId: 's1' }, 'tc1'),
        makeToolMsg({ ok: false, error: 'no step found' }, 'tc1'),
    ];
    const result = collapseFailed(msgs);
    eq(result.length, 2, 'non-probe failures kept as-is');
});

await t('2B: empty messages returns empty', () => {
    eq(collapseFailed([]), []);
});

await t('2B: collapses multiple consecutive failed probes', () => {
    const msgs = [];
    for (let i = 1; i <= 4; i++) {
        msgs.push(makeAssistantCall('probe', { code: `bad${i}(` }, `tc${i}`));
        msgs.push(makeToolMsg({ probeId: `p00${i}`, ok: false, error: `err${i}` }, `tc${i}`));
    }
    const result = collapseFailed(msgs);
    eq(result.length, 4, '4 failed pairs -> 4 collapsed lines');
    for (const m of result) {
        eq(m.role, 'user');
        ok(m.content.includes('FAILED'));
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// 2B — compactMessages
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 2B: compactMessages --');

function makeConversation(turnCount) {
    const msgs = [
        { role: 'system', content: 'SYSTEM_PROMPT' },
        { role: 'user', content: 'task description' },
    ];
    for (let i = 0; i < turnCount; i++) {
        msgs.push(makeAssistantCall('probe', { code: `code_${i}`, note: `n${i}` }, `tc${i}`));
        msgs.push(makeToolMsg({ probeId: `p${String(i+1).padStart(3,'0')}`, ok: true, resultPreview: String(i) }, `tc${i}`, i));
    }
    return msgs;
}

const fakeSummaryText = 'p001: ok — 0. p002: ok — 1. Sub-problem: open.';
let summarizerCalled = 0;

const mockAdapter = {
    async chatComplete(req) {
        summarizerCalled++;
        return { content: fakeSummaryText, usage: { inputTokens: 100, outputTokens: 50 }, costUSD: 0.0001 };
    },
};
const mockSummaryBinding = { configured: true, provider: 'deepseek', model: 'deepseek-chat', pricing: {}, maxTokens: 500 };
const mockBus = { appendEvent: () => ({ catch: () => {} }) };
const mockQuest = { id: 'q1' };
const mockCharm = { id: 'c1' };

await t('2B: compactMessages no-ops when messages count is too small', async () => {
    const msgs = makeConversation(3); // 2 + 6 = 8 messages, keepLast=6 means need > 2+12=14
    const before = summarizerCalled;
    const result = await compactMessages(msgs, 6, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    eq(result, msgs, 'should return same array unchanged');
    eq(summarizerCalled, before, 'summariser should not be called');
});

await t('2B: compactMessages no-ops when summaryBinding unconfigured', async () => {
    const msgs = makeConversation(10);
    const unconfiguredBinding = { configured: false };
    const before = summarizerCalled;
    const result = await compactMessages(msgs, 6, mockAdapter, unconfiguredBinding, mockBus, 's1', mockQuest, mockCharm);
    eq(result, msgs, 'should return same array unchanged when unconfigured');
    eq(summarizerCalled, before, 'summariser should not be called');
});

await t('2B: compactMessages no-ops when summaryBinding is null', async () => {
    const msgs = makeConversation(10);
    const before = summarizerCalled;
    const result = await compactMessages(msgs, 6, mockAdapter, null, mockBus, 's1', mockQuest, mockCharm);
    eq(result, msgs, 'should return same array unchanged when null');
    eq(summarizerCalled, before);
});

await t('2B: compactMessages calls summariser and inserts digest when history is long enough', async () => {
    const msgs = makeConversation(10); // 2 + 20 = 22 messages; keepLast=6 -> need > 2+12=14
    const before = summarizerCalled;
    const result = await compactMessages(msgs, 6, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    ok(summarizerCalled > before, 'summariser should be called');
    ok(result.length < msgs.length, `compacted (${result.length}) should be shorter than original (${msgs.length})`);
});

await t('2B: compactMessages preserves system message at index 0', async () => {
    const msgs = makeConversation(10);
    const result = await compactMessages(msgs, 6, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    eq(result[0].role, 'system');
    eq(result[0].content, 'SYSTEM_PROMPT');
});

await t('2B: compactMessages preserves task user message at index 1', async () => {
    const msgs = makeConversation(10);
    const result = await compactMessages(msgs, 6, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    eq(result[1].role, 'user');
    eq(result[1].content, 'task description');
});

await t('2B: compactMessages inserts digest as user message after head', async () => {
    const msgs = makeConversation(10);
    const result = await compactMessages(msgs, 6, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    eq(result[2].role, 'user', 'digest should be a user message');
    ok(result[2].content.includes('[History digest'), 'digest marker present');
    ok(result[2].content.includes(fakeSummaryText), 'summariser output in digest');
});

await t('2B: compactMessages preserves last keepLast*2 messages verbatim', async () => {
    const keepLast = 6;
    const msgs = makeConversation(10);
    const expectedTail = msgs.slice(msgs.length - keepLast * 2);
    const result = await compactMessages(msgs, keepLast, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    const actualTail = result.slice(result.length - keepLast * 2);
    eq(actualTail, expectedTail, 'last 12 messages should be verbatim');
});

await t('2B: compactMessages total length = 2 (head) + 1 (digest) + keepLast*2 (tail)', async () => {
    const keepLast = 6;
    const msgs = makeConversation(10);
    const result = await compactMessages(msgs, keepLast, mockAdapter, mockSummaryBinding, mockBus, 's1', mockQuest, mockCharm);
    eq(result.length, 2 + 1 + keepLast * 2, `expected ${2 + 1 + keepLast * 2}, got ${result.length}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2B — buildCompactionPrompt
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 2B: buildCompactionPrompt --');

await t('2B: buildCompactionPrompt returns a non-empty string', () => {
    const prompt = buildCompactionPrompt([]);
    ok(typeof prompt === 'string' && prompt.length > 0);
});

await t('2B: buildCompactionPrompt includes instruction to summarise under 200 words', () => {
    const prompt = buildCompactionPrompt([]);
    ok(prompt.includes('200'), 'should mention 200 word limit');
});

await t('2B: buildCompactionPrompt includes HISTORY separator', () => {
    const prompt = buildCompactionPrompt([]);
    ok(prompt.includes('HISTORY'), 'should include HISTORY separator');
});

await t('2B: buildCompactionPrompt renders ok probe result', () => {
    const msgs = [
        makeAssistantCall('probe', { code: 'Solve[x^2==4,x]', note: 'solve quadratic' }, 'tc1'),
        makeToolMsg({ probeId: 'p001', ok: true, resultPreview: '{{x->-2},{x->2}}' }, 'tc1'),
    ];
    const prompt = buildCompactionPrompt(msgs);
    ok(prompt.includes('p001'), 'probe id in prompt');
    ok(prompt.includes('ok'), 'ok status in prompt');
    ok(prompt.includes('{{x->-2},{x->2}}'), 'result preview in prompt');
});

await t('2B: buildCompactionPrompt renders failed probe', () => {
    const msgs = [
        makeAssistantCall('probe', { code: 'bad(', note: 'test' }, 'tc1'),
        makeToolMsg({ probeId: 'p001', ok: false, error: 'SyntaxError::sntx: ...' }, 'tc1'),
    ];
    const prompt = buildCompactionPrompt(msgs);
    ok(prompt.includes('FAILED'), 'FAILED marker in prompt');
    ok(prompt.includes('p001'), 'probe id in prompt');
});

await t('2B: buildCompactionPrompt renders record call', () => {
    const msgs = [
        makeAssistantCall('record', { stepId: 's1', description: 'the answer is 42', note: 'verified' }, 'tc1'),
        makeToolMsg({ stepId: 's1', ok: true }, 'tc1'),
    ];
    const prompt = buildCompactionPrompt(msgs);
    ok(prompt.includes('s1') || prompt.includes('record'), 'step or record in prompt');
});

await t('2B: buildCompactionPrompt renders collapsed failed lines (from collapseFailed)', () => {
    // After collapseFailed, failed pairs become user messages starting with '['
    const collapsed = [
        { role: 'user', content: '[p002: FAILED — eval_error]' },
    ];
    const prompt = buildCompactionPrompt(collapsed);
    ok(prompt.includes('[p002: FAILED'), 'collapsed line rendered in prompt');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2B — fairy_summariser role resolution
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 2B: fairy_summariser role --');

await t('2B: fairy_summariser role is in ALL_ROLES', () => {
    ok(roles.ALL_ROLES.includes('fairy_summariser'), 'fairy_summariser in ALL_ROLES');
});

await t('2B: fairy_summariser resolveRole returns an object with expected keys', () => {
    const r = roles.resolveRole('fairy_summariser');
    ok(r && typeof r === 'object', 'should return an object');
    ok('provider' in r, 'has provider');
    ok('model' in r, 'has model');
    ok('maxTokens' in r, 'has maxTokens');
    ok('configured' in r, 'has configured');
});

await t('2B: fairy_summariser maxTokens is 500 (cheap/short)', () => {
    const r = roles.resolveRole('fairy_summariser');
    eq(r.maxTokens, 500, 'maxTokens should be 500 for summariser');
});

await t('2B: fairy_summariser falls back to fairy model when no override', () => {
    const fairy        = roles.resolveRole('fairy');
    const summariser   = roles.resolveRole('fairy_summariser');
    // Without an explicit config override, summariser should inherit fairy's model+provider
    // (may be empty strings if not configured in the test env — that's fine)
    eq(summariser.model,    fairy.model,    'summariser should use fairy model as fallback');
    eq(summariser.provider, fairy.provider, 'summariser should use fairy provider as fallback');
});

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n-- Stage 2 Results: ${pass} passed, ${fail} failed --`);
if (failures.length) {
    console.error('\nFailed tests:');
    for (const f of failures) console.error(`  x ${f.name}: ${f.error}`);
}
process.exit(fail > 0 ? 1 : 0);

})();
