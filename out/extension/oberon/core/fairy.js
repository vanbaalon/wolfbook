'use strict';
/**
 * Oberon — Fairy worker (Phase 3: FSM-driven loop).
 *
 * State machine:
 *   intake → explore → compile → verify → delivered
 *                             ↘ diagnose ↗ ↓
 *                                          failed | escalate
 *
 * The model uses 8 internal tools (probe, inspect, lookup, record, assume,
 * chain, invalidate, finalize) instead of the old wolfram_eval/editCell set.
 * Tool budget is enforced by FairyFSM.
 *
 * Events emitted:
 *   fairy.started, llm.call, llm.reasoning_progress, llm.response_progress,
 *   tool.call, correlated.tool, omen{...}, scroll.submitted
 */

const crypto = require('crypto');
const path   = require('path');
const fsp    = require('fs/promises');
const vscode = require('vscode');

const { getAdapter }     = require('../providers');
const { computeCost }    = require('../providers/cost');
const { sha256 }         = require('./promptAssembly');
const tricksMod          = require('../fairy/tricks');
const { makeSpanId }     = require('../telemetry/bus');
const settings           = require('../config/settings');
const roles              = require('../config/roles');
const scrollsFs          = require('../memory/scrolls');
const project            = require('../memory/project');
const contributionInbox  = require('../memory/contributionInbox');
const wolframShim        = require('./wolframShim');
const { FairyFSM }       = require('../fairy/fsm');
const { FAIRY_TOOL_SPECS, EXPLORE_FAIRY_TOOL_SPECS, POLISH_FAIRY_TOOL_SPECS, FAILED_PROBE_TOOL_SPECS, FAILED_PROBE_FIX_TOOL_SPECS, RECORD_GATE_TOOL_SPECS, PARTIAL_REPORT_TOOL_SPECS } = require('../fairy/toolSpecs');

// Probe-failure kinds where the kernel actually EVALUATED the code and a ❌ cell
// exists in working.wb (amendable). Harness rejections (redefinition, near-dup,
// syntax lint, missing-analysis) never evaluate — nothing to amend.
const KERNEL_FAIL_KINDS = new Set(['error', 'messages', 'timeout', 'eval_error',
    // expect_failed: the cell ran but contradicts the agent's own machine-checked
    // expectation — semantically broken, must be fixed in place like any ❌ cell.
    'expect_failed']);
// Tools the model may actually invoke during the polish phase. Anything else (notably
// invalidate, which deletes the verified clean.wb) is rejected before dispatch.
const POLISH_ALLOWED = new Set(['run_clean', 'edit_cell', 'probe', 'chain', 'finalize']);
const { dispatchFairyTool }  = require('../fairy/tools');
const { analyzeCode, WL_BUILTINS } = require('../fairy/depAnalyzer');
const { createWorkDir }      = require('../fairy/workDir');
const { compile } = require('../fairy/harness');   // verify/autoCorrect: legacy subprocess-verify path, unused since run_clean
const { buildSkillsUsedMarkdown, buildLiteratureCitations, buildLiteratureBriefMarkdown } = require('../fairy/skillCitation');
const { reasoningTail } = require('../fairy/notebookBanners');
const {
    FAIRY_SYSTEM_PROMPT,
    buildExploreUserMessage,
    buildRecallContextBlock,
    buildDiagnoseUserMessage,
    buildBudgetReminderMessage,
    buildCompactionPrompt,
    buildPolishEntryMessage,
    buildPartialReportUserMessage,
} = require('../fairy/prompts');
const { runRecall }      = require('../fairy/recall');
const { SkilXivClient }  = require('../fairy/skilxivClient');
const skillGaps          = require('../memory/skillGaps');

// ── Constants ─────────────────────────────────────────────────────────────────

// I18: build stamp — run Q_38X439 executed a stale deploy silently (old code,
// old bugs, user assumed fixes were live). Every run now records which build ran.
const BUILD_INFO = (() => {
    try {
        const fs = require('fs');
        let version = null;
        try { version = require('../../../../package.json').version || null; } catch (_) {}
        return { version, codeMtime: new Date(fs.statSync(__filename).mtimeMs).toISOString() };
    } catch (_) { return { version: null, codeMtime: null }; }
})();

// ── Skill-draft author (I14) ─────────────────────────────────────────────────
// One cheap LLM call that turns a DELIVERED, verified chain into a reviewable
// SKILL.draft.md — a stated, generalised method rather than the raw ledger dump
// the inbox candidate carries. Only runs for novel results (I15 gate).

function buildSkillAuthorPrompt({ task, definitionsLedger, factsLedger }) {
    return [
        'You are turning a VERIFIED Wolfram Language derivation into a draft reusable skill.',
        'Reply ONLY with JSON:',
        '{"name": "kebab-case-name (≤50 chars, method-oriented, not task-verbatim)",',
        ' "summary": "one sentence, ≤160 chars, states METHOD + what it computes",',
        ' "method": "markdown, 3-8 sentences: the REUSABLE method/algorithm, stated generally (which objects to build, in what order, what to verify) — not just this instance",',
        ' "keyResult": "one sentence stating the verified result of this instance"}',
        '',
        `TASK SOLVED: ${String(task || '').slice(0, 500)}`,
        '',
        'VERIFIED DEFINITIONS (from the clean notebook):',
        String(definitionsLedger || '').slice(0, 5000),
        '',
        'ESTABLISHED RESULTS:',
        String(factsLedger || '').slice(0, 1500),
    ].join('\n');
}

function parseSkillAuthorReply(text) {
    try {
        const o = JSON.parse(String(text || '').match(/\{[\s\S]*\}/)[0]);
        const name = String(o.name || '').toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
        if (!name || !o.summary || !o.method) return null;
        return {
            name,
            summary:   String(o.summary).slice(0, 160),
            method:    String(o.method).slice(0, 2500),
            keyResult: String(o.keyResult || '').slice(0, 300),
        };
    } catch (_) { return null; }
}

function composeSkillDraftMd({ authored, task, definitionsLedger, model }) {
    return [
        '---',
        'schema_version: "1.0"',
        `name: ${authored.name}`,
        'namespace: "@draft"',
        'version: 0.1.0',
        'license: CC-BY-4.0',
        `summary: ${JSON.stringify(authored.summary)}`,
        'runtime: wolfram',
        'visibility: private',
        `generated_with: "wolfbook-fairy/${model || 'unknown'}"`,
        '---',
        '',
        `# ${authored.name}`,
        '',
        '## Method',
        '',
        authored.method,
        '',
        ...(authored.keyResult ? ['## Verified result', '', authored.keyResult, ''] : []),
        '## Task instance',
        '',
        String(task || '').slice(0, 600),
        '',
        '## Verified definitions',
        '',
        '```wolfram',
        String(definitionsLedger || '').slice(0, 8000),
        '```',
        '',
        '> Draft authored automatically from a delivered run — review before publishing.',
    ].join('\n');
}

/**
 * Append text to the content of the most recent tool or user message in the
 * conversation. This keeps system-injected hints (budget warnings, failure
 * nudges) inside the existing message sequence so the cache prefix is never
 * broken by an extra user message in the middle of a turn.
 *
 * Falls back to pushing a new user message if no prior tool/user message exists.
 */
function appendToLastToolOrUser(messages, text) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'tool' || m.role === 'user') {
            messages[i] = { ...m, content: (m.content || '') + '\n\n' + text };
            return;
        }
    }
    messages.push({ role: 'user', content: text });
}

/**
 * Replace each failed (assistant-call, tool-fail) probe pair with a one-line
 * collapsed entry. Used before sending history to the summariser so it sees a
 * compact representation of dead-ends rather than full error payloads.
 */
function collapseFailed(messages) {
    const result = [];
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (
            m.role === 'assistant' &&
            Array.isArray(m.tool_calls) && m.tool_calls.length === 1 &&
            m.tool_calls[0].function.name === 'probe' &&
            i + 1 < messages.length &&
            messages[i + 1].role === 'tool'
        ) {
            let content = {};
            try { content = JSON.parse(messages[i + 1].content || '{}'); } catch (_) {}
            if (content.ok === false) {
                const probeId   = content.probeId || '?';
                const errSnip   = (content.error || content.kind || 'error').slice(0, 80);
                result.push({ role: 'user', content: `[${probeId}: FAILED — ${errSnip}]` });
                i += 2;
                continue;
            }
        }
        result.push(m);
        i++;
    }
    return result;
}

/**
 * Call the cheap summariser model to distill message history into a digest.
 * Never throws — returns a bracketed error string on failure.
 */
async function callSummariser(adapter, binding, promptText, bus, spanId, quest, charm) {
    try {
        const req = {
            messages: [
                { role: 'system', content: 'You are a concise technical summariser for Wolfram Language computation logs.' },
                { role: 'user',   content: promptText },
            ],
            model:       binding.model,
            temperature: 0.1,
            maxTokens:   binding.maxTokens || 500,
            signal:      null,
        };
        const result = await adapter.chatComplete(req, { pricing: binding.pricing });
        bus.appendEvent('llm.call', {
            role: 'fairy_summariser', model: binding.model,
            usage: result.usage || {}, costUSD: result.costUSD || null,
            promptMessages: req.messages,
        }, { spanId, questId: quest && quest.id, charmId: charm && charm.id }).catch(() => {});
        return result.content || '[empty summary]';
    } catch (e) {
        return `[summariser unavailable: ${e && e.message}]`;
    }
}

/**
 * O1: find a safe start index for the verbatim tail. The tail must not begin with a
 * `tool` message (which must directly follow its assistant `tool_calls`). Starting at
 * the desired length, walk BACKWARD to the nearest non-`tool` message (preferring an
 * assistant, so any tool responses that belong to it are kept together). Never returns
 * an index below `minStart`.
 *
 * @param {object[]} messages
 * @param {number} desiredTailLen
 * @param {number} minStart
 * @returns {number}
 */
/**
 * O6: rough character estimate of the message context (≈ 4 chars/token). Counts
 * message content plus serialized tool_calls so growth from tool arguments is seen.
 * @param {object[]} messages
 * @returns {number}
 */
function estimateContextChars(messages) {
    let n = 0;
    for (const m of messages) {
        if (typeof m.content === 'string') n += m.content.length;
        if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                n += ((tc.function && tc.function.arguments) || '').length + ((tc.function && tc.function.name) || '').length;
            }
        }
    }
    return n;
}

function findSafeTailStart(messages, desiredTailLen, minStart) {
    let idx = Math.max(minStart, messages.length - desiredTailLen);
    while (idx > minStart && messages[idx] && messages[idx].role === 'tool') idx--;
    return idx;
}

/**
 * Slim request context for a selective THINK turn (2026-08-02, run 13-30-18):
 * thinking requests cannot reuse the fast-turn prompt cache (61% miss rate
 * observed; one 203k-token polish think missed 194k tokens to produce a
 * 60-token decision). A reflection needs the task, the state digest, and the
 * recent tail — not 100k+ of verbatim history. Returns null when the history
 * is small enough that slimming isn't worth the bridge note.
 *
 * The slim view is REQUEST-LOCAL: the think turn's reply is appended to the
 * full history as usual.
 */
function buildThinkContext(messages, stateDigest) {
    if (messages.length <= 16) return null;
    const head = messages.slice(0, 2);   // [system, first user] — same cache prefix
    const tailStart = findSafeTailStart(messages, 10, 2);
    const tail = messages.slice(tailStart);
    const bridge = { role: 'user', content:
        '[Reflection context: the earlier working history is elided for this turn. ' +
        'The state digest below and the recent messages that follow carry the ' +
        'established state — decide from these.]' +
        (stateDigest ? `\n\n${stateDigest}` : '') };
    return [...head, bridge, ...tail];
}

/**
 * O1: defensive pass — drop any `tool` message that is not immediately preceded by an
 * assistant message carrying tool_calls. Guarantees the array we send can never trip
 * the provider's "tool must follow tool_calls" rule, regardless of how it was built.
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
function sanitizeToolPairing(messages) {
    // Pass 1: drop orphan tool messages. A tool message is valid if its tool_call_id
    // belongs to the NEAREST preceding assistant tool_calls message — walking back past
    // SIBLING tool messages (a single assistant turn can carry multiple tool_calls, so
    // the 2nd/3rd tool result is preceded by another tool message, not the assistant).
    // The old "immediately-preceded-by-assistant" rule wrongly dropped those siblings,
    // which left the assistant tool_calls with missing responses → provider 400.
    const kept = [];
    for (const m of messages) {
        if (m && m.role === 'tool') {
            let j = kept.length - 1;
            while (j >= 0 && kept[j] && kept[j].role === 'tool') j--;
            const anchor = j >= 0 ? kept[j] : null;
            const ok = anchor && anchor.role === 'assistant' && Array.isArray(anchor.tool_calls)
                && anchor.tool_calls.some(tc => tc && tc.id === m.tool_call_id);
            if (!ok) continue;  // orphan tool response — drop it
        }
        kept.push(m);
    }
    // Pass 2: the inverse constraint — every assistant tool_calls id MUST have a tool
    // message. Synthesize a placeholder for any that are missing (e.g. elided during
    // compaction), so we never send an assistant tool_calls without all its responses.
    const out = [];
    for (let i = 0; i < kept.length; i++) {
        const m = kept[i];
        out.push(m);
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const present = new Set();
            let k = i + 1;
            while (k < kept.length && kept[k] && kept[k].role === 'tool') { present.add(kept[k].tool_call_id); out.push(kept[k]); k++; }
            for (const tc of m.tool_calls) {
                if (tc && tc.id && !present.has(tc.id)) {
                    out.push({ role: 'tool', tool_call_id: tc.id, content: '{"ok":true,"note":"result elided during compaction"}' });
                }
            }
            i = k - 1;  // skip the tool messages already emitted
        }
    }
    return out;
}

/**
 * Compact the message history by replacing old turns with an LLM-generated digest.
 *
 * Always keeps:
 *   messages[0] — system prompt (fixed, always cached)
 *   messages[1] — first user message (task description)
 *   last keepLast*2 messages — verbatim recent turns (snapped to a safe boundary)
 *
 * Returns a new array; does not mutate the input.
 * Skips compaction silently if there is not enough history or the summariser is unconfigured.
 */
async function compactMessages(messages, keepLast, adapter, summaryBinding, bus, spanId, quest, charm, workDir) {
    if (!summaryBinding || !summaryBinding.configured) return messages;

    const FIXED_HEAD = 2;
    const minLength  = FIXED_HEAD + keepLast * 2;
    if (messages.length <= minLength) return messages;

    const head         = messages.slice(0, FIXED_HEAD);
    // O1: the verbatim tail MUST begin at a message that can legally follow a user
    // summary — i.e. an assistant or user message, never an orphan `tool` response
    // (a tool message must directly follow its assistant `tool_calls`). A blind slice
    // frequently lands mid tool_calls/tool pair → provider 400 → run killed. Snap the
    // boundary backward to the nearest assistant/user message at or before the target.
    const tailStart    = findSafeTailStart(messages, keepLast * 2, FIXED_HEAD);
    const toSummarise  = messages.slice(FIXED_HEAD, tailStart);
    const verbatimTail = messages.slice(tailStart);

    const collapsed   = collapseFailed(toSummarise);
    const promptText  = buildCompactionPrompt(collapsed);
    const summaryText = await callSummariser(adapter, summaryBinding, promptText, bus, spanId, quest, charm);

    const turnsSummarised = Math.floor(toSummarise.length / 2);

    // R3: preserve definitions and established facts VERBATIM — never summarise them away.
    const ledgerParts = [];
    if (workDir) {
        const [defs, facts] = await Promise.all([
            workDir.buildDefinitionsLedger({ maxChars: 4000 }).catch(() => ''),
            workDir.buildFactsLedger({ maxChars: 1200 }).catch(() => ''),
        ]);
        if (defs)  ledgerParts.push('[Definitions still alive in the kernel — verbatim, call by name:\n' + defs + '\n]');
        if (facts) ledgerParts.push('[Established results — verbatim:\n' + facts + '\n]');
    }
    const ledgerMsgs = ledgerParts.map(content => ({ role: 'user', content }));

    const summaryMsg = {
        role: 'user',
        content: `[History digest — ${turnsSummarised} turns]\n${summaryText}`,
    };

    // O1: final defensive sanitize so no orphan tool message can ever be sent.
    return sanitizeToolPairing([...head, ...ledgerMsgs, summaryMsg, ...verbatimTail]);
}

const STEER_NO_ACTION =
    'No tool call or control signal found. ' +
    'If your chain is complete, emit the `done_exploring` control signal as plain JSON. ' +
    'If not, call a tool (probe, inspect, lookup, record, assume, chain, invalidate, or finalize).';

/** P4: auto-checkpoint trigger — fire every `every` records. */
function shouldAutoCheckpoint(recordsSinceCheckpoint, every = 3) {
    return recordsSinceCheckpoint > 0 && recordsSinceCheckpoint % every === 0;
}

/**
 * M9: extract the primary symbol a probe DEFINES, for repeat-and-abandon detection.
 * Returns the LHS symbol of the first `name := …`, `name[args] := …`, or `name = …`
 * (Set/SetDelayed) at a statement boundary, or null if the probe defines nothing.
 *
 * @param {string} code
 * @returns {string|null}
 */
function extractTargetSymbol(code) {
    if (!code || typeof code !== 'string') return null;
    // Match a symbol at the start of a line (optionally after whitespace/comments),
    // optionally followed by a [...] pattern arg list, then = or :=
    const re = /(?:^|\n)\s*([A-Za-z$][A-Za-z0-9$]*)\s*(?:\[[^\]]*\])?\s*:?=(?![=])/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const sym = m[1];
        // Skip pure equality/comparison artifacts and obvious non-definitions.
        if (sym && sym.length > 0) return sym;
    }
    return null;
}


// ── SteerQueue ─────────────────────────────────────────────────────────────────

/**
 * Thread-safe (single-threaded JS) queue for user steering messages.
 * The UI layer pushes text; runModelTurns drains one message per turn.
 */
class SteerQueue {
    constructor() { this._items = []; }

    /** @param {string} text — raw user input (caller should pre-slice to max length) */
    push(text) { this._items.push(String(text)); }

    /** Returns the oldest queued text and removes it, or null if empty. */
    drain() { return this._items.length ? this._items.shift() : null; }
}

// ── Core LLM call utilities (kept from prior implementation) ──────────────────

function tryParseJson(text) {
    const s = String(text || '').trim();
    if (!s) return { ok: false, error: 'empty response' };

    function maybeUnwrap(val) {
        if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') return val[0];
        return val;
    }

    const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/;
    const fenceMatch = s.match(fenceRe);
    if (fenceMatch && fenceMatch[1]) {
        const inner = fenceMatch[1].trim();
        if (inner.startsWith('{') || inner.startsWith('[')) {
            try { return { ok: true, value: maybeUnwrap(JSON.parse(inner)) }; } catch (_) {}
        }
    }
    const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    if (stripped.startsWith('{') || stripped.startsWith('[')) {
        try { return { ok: true, value: maybeUnwrap(JSON.parse(stripped)) }; } catch (_) {}
    }
    const firstBrace   = s.indexOf('{');
    const firstBracket = s.indexOf('[');
    if (firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)) {
        const lastBracket = s.lastIndexOf(']');
        if (lastBracket > firstBracket) {
            try { return { ok: true, value: maybeUnwrap(JSON.parse(s.slice(firstBracket, lastBracket + 1))) }; }
            catch (_) {}
        }
    }
    const last = s.lastIndexOf('}');
    if (firstBrace >= 0 && last > firstBrace) {
        const slice = s.slice(firstBrace, last + 1);
        try { return { ok: true, value: JSON.parse(slice) }; }
        catch (e) { return { ok: false, error: `JSON parse failed: ${e.message}` }; }
    }
    return { ok: false, error: 'no JSON object found in response' };
}

function stableArgsKey(args) {
    if (!args || typeof args !== 'object') return String(args);
    try {
        const keys = Object.keys(args).sort();
        const parts = keys.map(k => k + '=' + JSON.stringify(args[k]));
        const s = parts.join('|');
        return s.length > 256 ? s.slice(0, 256) : s;
    } catch (_) { return ''; }
}

function truncateArgsForUi(args) {
    if (!args || typeof args !== 'object') return args;
    const out = {};
    for (const k of Object.keys(args)) {
        const v = args[k];
        out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
    }
    return out;
}

async function callOnce({ bus, adapter, binding, messages, tools, toolChoice, signal, spanId, prefixSha256, quest, charm, turnIndex, thinkTurn, thinkEffort, thinkBoost, fastCap, thinkContext }) {
    const tel = settings.telemetry();

    // O3: the old retroactive age-based trimming of tool messages mutated the
    // prompt PREFIX on every turn (each turn another message crossed the age-3 /
    // age-7 boundary), which invalidated the provider prompt cache from that point
    // on — twice per message. Tool outputs are already capped at insertion time
    // (probe 400 / inspect 800 chars); any further trimming now happens ONLY in
    // compactMessages, where the prefix breaks anyway.

    // Deliberate thinking turns get extra output headroom: the reasoning shares
    // max_tokens with the answer, and the entry/planning think on a hard task
    // overran the plain 12k cap (run 21-04-54: truncated-empty at 12000).
    const baseMaxTokens = binding.maxTokens || 8000;
    // I2: headroom scales with declared effort class — research thinks get the
    // full boost; standard thinks are budgeted tighter (they averaged 12k
    // output tokens each on baselineff with no quality evidence for the tail).
    //
    // fastCap (run 10-41-07): once thinking is capped, the model "thinks in
    // content" — 12k-token plaintext essays truncating with NO tool call
    // (12 such turns, 100–280 s each). A fast tool-calling turn never needs
    // more than a few k output (probe/edit code is char-capped upstream), so
    // callers cap it; a truncated essay then fails 3× cheaper and faster.
    const turnMaxTokens = thinkTurn
        ? Math.min(baseMaxTokens + (thinkBoost ?? 12000), 32000)   // ?? — an explicit 0 boost means BASE cap, not the default
        : (typeof fastCap === 'number' ? Math.min(baseMaxTokens, fastCap) : baseMaxTokens);
    const req = {
        // Final safety net: guarantee tool_calls/tool pairing on EVERY send (not just after
        // compaction) so a malformed history can never 400 the run mid-explore.
        // Think turns may use a slim request-local context (cache-miss economics).
        messages: sanitizeToolPairing((thinkTurn && thinkContext) ? thinkContext : messages),
        model:          binding.model,
        temperature:    0.3,
        maxTokens:      turnMaxTokens,
        responseFormat: tools ? undefined : 'json_object',
        signal,
        tools, toolChoice,
        // Thinking: per-role opt-in (roles.<role>.thinking) OR a selective
        // per-turn request (fairy.reasoning cadence/events). The adapter owns
        // the wire contract (effort param, inert-sampling omission, no forced
        // tool_choice; non-thinking requests get reasoning_effort:'none' to
        // suppress V4's unbounded auto-thinking). Mixed-mode histories are
        // safe WITHOUT reasoning round-trip (verified live 2026-08-01).
        thinking:        binding.thinking === true || !!thinkTurn,
        reasoningEffort: binding.thinking === true
            ? (binding.reasoningEffort || undefined)
            : (thinkTurn ? (thinkEffort || 'medium') : undefined),
    };
    // Thinking-request contract (empirically mapped 2026-08-02): in thinking
    // mode the API requires reasoning_content on EVERY assistant tool-call
    // message in history — impossible for fast-turn messages — UNLESS a user
    // message follows the last tool round, which lifts the requirement
    // entirely. So every thinking request gets a reflection prompt appended
    // (request-local): it satisfies the contract AND directs the think turn.
    // Run 21-32-31: 18 of 18 in-run thinking attempts 400'd without this.
    if (req.thinking) {
        const last = req.messages[req.messages.length - 1];
        if (!last || (last.role !== 'user' && last.role !== 'system')) {
            req.messages = [...req.messages, { role: 'user', content:
                '[Reflection turn] Pause and think before acting: assess the current state of the ' +
                'derivation against the task, check the recent results for errors or dead ends, and ' +
                'decide the most effective next action. Do NOT compute anything by hand — no ' +
                'arithmetic, no root-tracking, no algebra in your head; identify WHAT to compute ' +
                'and let the kernel do it. Keep the deliberation TIGHT — a decision, not an essay — ' +
                'then act: tool call or control signal.' }];
        }
    }

    // Cache-fingerprint telemetry: hash of the stable prefix (system + first
    // user message). A changed prefixSha256 between consecutive turns of one
    // charm = a cache-discipline regression (was wired but always null).
    if (!prefixSha256) {
        try {
            const head = (messages[0] && messages[0].content || '') + '|' + (messages[1] && messages[1].content || '');
            prefixSha256 = sha256(head);
        } catch (_) {}
    }

    const attempt = async (reqToSend) => {
        let result;
        try {
            let _reasoningAccum = '';
            let _responseAccum  = '';
            let _reasoningSent = 0, _responseSent = 0;   // delta cursors (Run Inspector live view)
            let _reasoningSeq = 0, _responseSeq = 0;     // seq===0 → viewer starts a fresh buffer
            let _lastEmitMs = 0;
            const REASONING_FLUSH_MS = 200;
            const onChunk = (chunk) => {
                const now = Date.now();
                if (chunk.type === 'reasoning' && chunk.text) {
                    _reasoningAccum += chunk.text;
                    if (now - _lastEmitMs < REASONING_FLUSH_MS) return;
                    _lastEmitMs = now;
                    const delta = _reasoningAccum.slice(_reasoningSent);
                    _reasoningSent = _reasoningAccum.length;
                    bus.appendEvent('llm.reasoning_progress', {
                        role: 'fairy', questId: quest.id, charmId: charm.id, turnIndex,
                        preview: _reasoningAccum.slice(-1800),   // fills the scrolling status box
                        delta, seq: _reasoningSeq++,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                } else if ((chunk.type === 'content' || chunk.type === 'text') && chunk.text) {
                    _responseAccum += chunk.text;
                    if (now - _lastEmitMs < REASONING_FLUSH_MS) return;
                    _lastEmitMs = now;
                    const delta = _responseAccum.slice(_responseSent);
                    _responseSent = _responseAccum.length;
                    bus.appendEvent('llm.response_progress', {
                        role: 'fairy', questId: quest.id, charmId: charm.id, turnIndex,
                        preview: _responseAccum.slice(-400),
                        delta, seq: _responseSeq++,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }
            };
            result = await adapter.chatComplete(reqToSend, { pricing: binding.pricing, onChunk });
        } catch (e) {
            await bus.appendEvent('omen', {
                kind: 'provider_error',
                message: e && e.message || String(e),
                detail: { provider: binding.provider, model: binding.model, status: e && e.status || null },
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            throw e;
        }

        const costUSD = (typeof result.costUSD === 'number')
            ? result.costUSD
            : computeCost(result.usage, binding.pricing);

        // Telemetry hygiene (2026-08-01, run TS03: verbatim promptMessages made
        // one run's JSONL 22.7 MB and bloated the in-memory ring + Run Inspector
        // posts). Store a compact digest; full blobs stay opt-in via
        // telemetry.saveRawPrompts/saveRawResponses.
        await bus.appendEvent('llm.call', {
            role: 'fairy', provider: result.provider, model: result.model,
            usage: result.usage, costUSD, latencyMs: result.latencyMs,
            stopReason: result.stopReason, prefixSha256, turnIndex,
            thinking: !!reqToSend.thinking,
            toolCallsRequested: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
            promptDigest: {
                messageCount: reqToSend.messages.length,
                contextChars: estimateContextChars(reqToSend.messages),
                lastRole: reqToSend.messages.length ? reqToSend.messages[reqToSend.messages.length - 1].role : null,
            },
            responseText: capStrTail(result.content, 4000),
            reasoning: capStrTail(result.reasoning, 2000),
            promptBlob:   tel.saveRawPrompts   ? sha256(JSON.stringify(reqToSend.messages)) : null,
            responseBlob: tel.saveRawResponses ? sha256(result.content || '')     : null,
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

        return result;
    };

    let result = await attempt(req);

    // Truncated-before-output recovery — now a rare backstop: the primary cure
    // is `reasoning_effort: "none"` at the adapter (empirically verified to
    // disable V4's auto-thinking, 2026-08-01). If a truncation still slips
    // through, retry ONCE at the SAME cap with a be-direct nudge — the
    // baseline4 A/B showed a DOUBLED cap just lets the runaway think run twice
    // as long (5 retries maxed 24k tokens): never give a runaway more rope.
    // The nudge is retry-local — it never enters the caller's history.
    const emptyTruncation = (r) => r && r.stopReason === 'length'
        && !(Array.isArray(r.toolCalls) && r.toolCalls.length)
        && !String(r.content || '').trim();
    if (emptyTruncation(result)) {
        await bus.appendEvent('omen', {
            kind: 'length_stop_empty',
            message: `LLM hit the ${req.maxTokens}-token output cap before emitting content/tool calls (reasoning overrun) — retrying once in FAST (non-thinking) mode with a be-direct nudge.`,
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        // Retry in FAST mode: a think that ran past an enlarged cap will run
        // past it again (run 21-04-54: entry think truncated twice in a row) —
        // degrade the turn to non-thinking rather than re-litigating the think.
        const retryReq = Object.assign({}, req, {
            thinking: false, reasoningEffort: undefined, maxTokens: baseMaxTokens,
            messages: [...req.messages, { role: 'user', content:
                '[harness notice] Your previous attempt was cut off at the output-token cap before ' +
                'producing any answer (excessive internal deliberation). Respond NOW and be direct: ' +
                'emit the tool call (or the short JSON control signal) immediately, with at most a ' +
                'few sentences of visible working. Do not re-derive from scratch.' }],
        });
        result = await attempt(retryReq);
        result.lengthStopRecovered = true;
        // Signal the caller that a THINK turn overran with zero output — the
        // loop uses this to strike-disable thinking for the rest of the run
        // (run 16-30-00: 4 of the first 5 thinks burned the full 24k cap each,
        // ~96k output tokens / ~20 min of pure waste before any protection).
        if (req.thinking) result.reasoningOverrun = true;
    }

    return result;
}

/**
 * Serialize a tool result for the message history with a hard size cap —
 * the last line of defense against any single tool result flooding the
 * context (run 22-39-08: one uncapped 316k-char result entered history and
 * every subsequent call re-paid it, mostly at cache-miss prices). Full
 * results always live on disk (results/<probeId>.json → inspect).
 */
const TOOL_MSG_CAP = 12000;
function toolMsgContent(payload) {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (s.length <= TOOL_MSG_CAP) return s;
    return JSON.stringify({
        truncated: true,
        note: `tool result was ${s.length} chars — elided to protect the context; use inspect (or re-request narrower output) for details`,
        head: s.slice(0, TOOL_MSG_CAP - 2500),
        tail: s.slice(-2000),
    });
}

/** Cap a string keeping head and tail (telemetry-payload hygiene). */
function capStrTail(s, cap) {
    if (s == null) return null;
    const str = String(s);
    if (str.length <= cap) return str;
    const half = Math.floor(cap / 2);
    return str.slice(0, half) + ` …[${str.length - cap} chars elided]… ` + str.slice(-half);
}

async function callOnceWithRetry(params, _attempt = 0) {
    // Up to 4 transient retries with escalating backoff (run em5e41 died to a
    // ~30 s network blip: ONE 1.5 s retry, then straight to escalate — a whole
    // run lost to a hiccup shorter than a kernel restart).
    const RETRY_DELAYS_MS = [1500, 6000, 15000, 30000];
    const isAborted = () => params.signal && params.signal.aborted;
    try {
        return await callOnce(params);
    } catch (e) {
        if (isAborted()) throw e;
        const status = e && e.status;
        // Last-resort thinking fallback (run 21-04-54 died on exactly this): if a
        // THINKING request 400s on the reasoning_content round-trip contract,
        // downgrade THIS turn to non-thinking and continue — a degraded turn
        // always beats escalating the whole run on a protocol disagreement.
        if (status === 400 && params.thinkTurn
            && /reasoning_content/i.test(String(e && e.message || ''))) {
            try {
                await params.bus.appendEvent('omen', {
                    kind:    'thinking_turn_downgraded',
                    message: 'Thinking request rejected on the reasoning_content contract — re-running this turn in fast mode.',
                }, { spanId: params.spanId, questId: params.quest.id, charmId: params.charm.id });
            } catch (_) {}
            return await callOnce(Object.assign({}, params, { thinkTurn: false }));
        }
        const isTransient =
            !status ||
            status >= 500 ||
            status === 429 ||
            /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(String(e && e.message || ''));
        if (!isTransient) throw e;
        if (_attempt >= RETRY_DELAYS_MS.length) throw e;
        const waitMs = Math.max(Number(e.retryAfterMs) || 0, RETRY_DELAYS_MS[_attempt]);
        try {
            await params.bus.appendEvent('omen', {
                kind:    'provider_retry',
                message: `Transient provider error (status=${status || 'n/a'}); retry ${_attempt + 1}/${RETRY_DELAYS_MS.length} after ${waitMs}ms.`,
                detail:  { message: e.message || String(e), retryAfterMs: waitMs },
            }, { spanId: params.spanId, questId: params.quest.id, charmId: params.charm.id });
        } catch (_) {}
        await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, waitMs);
            if (params.signal) {
                const onAbort = () => { clearTimeout(t); reject(new Error('aborted during retry backoff')); };
                if (params.signal.aborted) onAbort();
                else params.signal.addEventListener('abort', onAbort, { once: true });
            }
        });
        return await callOnceWithRetry(params, _attempt + 1);
    }
}

// ── Phase 3 helpers ───────────────────────────────────────────────────────────

/**
 * Compute the absolute charmDir path for this run.
 * <wsRoot>/quests/<questId>_<shortName>/charms/<charmId>/
 */
function resolveCharmDir(quest, charm) {
    const qDir = project.questsDir();
    if (!qDir) throw new Error('No workspace open; cannot resolve charmDir');
    const questFolder = require('../memory/quests').questFolderName(quest);
    return path.join(qDir, questFolder, 'charms', charm.id);
}

/**
 * Parse a JSON control signal embedded in model text output.
 * Returns the parsed object (with .control string) or null.
 */
function tryParseControlSignal(text) {
    const parsed = tryParseJson(text);
    if (parsed.ok && parsed.value && typeof parsed.value.control === 'string') {
        return parsed.value;
    }
    return null;
}

/**
 * Return the recorded probe value (InputForm string) for targetStepId's probe.
 */
async function findRecordedValue(workDir, targetStepId) {
    const steps = await workDir.loadValidSteps().catch(() => []);
    const step  = steps.find(s => s.id === targetStepId);
    if (!step || !step.probeId) return null;
    const probe = await workDir.getProbe(step.probeId).catch(() => null);
    return probe ? (probe.value || null) : null;
}

/**
 * Restart the working kernel and evaluate task inputs + set $Assumptions.
 * Gracefully no-ops when the kernel is unavailable.
 */
async function setupWorkingKernel({ workDir, inputs, assumptions, bus, signal, spanId, quest, charm }) {
    const ks = wolframShim.kernelStatus();
    if (!ks.available) {
        await bus.appendEvent('omen', {
            kind:    'kernel_unavailable_warning',
            message: `Wolfram kernel not available (${ks.reason}); Fairy will run without live evaluation.`,
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        return { kernelFresh: false, inputsLoaded: 0 };
    }

    let kernelFresh = false;
    try {
        const r = await wolframShim.restartKernel();
        kernelFresh = !!r.ok;
        if (!r.ok) {
            await bus.appendEvent('omen', {
                kind:    'kernel_reset_failed',
                message: `Kernel restart failed: ${r.reason || 'unknown'}. Continuing with current state.`,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        }
    } catch (_) {}

    let inputsLoaded = 0;
    if (inputs && inputs.length > 0) {
        await workDir.setInputs(inputs).catch(() => {});
        for (const inp of inputs) {
            if (inp.code) {
                await wolframShim.evalOnce({ expression: inp.code, signal }).catch(() => {});
                inputsLoaded++;
            }
        }
    }

    if (assumptions && assumptions.length > 0) {
        for (const a of assumptions) {
            await workDir.upsertAssumption(a).catch(() => {});
        }
        // O2: declared-parameter assumptions (prose: true) are documentation for the
        // model and the deliverable — never WL expressions for $Assumptions.
        const wlExprs = assumptions.filter(a => !a.prose).map(a => a.wlAssumption || a.statement).filter(Boolean);
        if (wlExprs.length > 0) {
            const expr = wlExprs.length === 1
                ? `$Assumptions = ${wlExprs[0]};`
                : `$Assumptions = And[${wlExprs.join(', ')}];`;
            await wolframShim.evalOnce({ expression: expr, signal }).catch(() => {});
        }
    }

    return { kernelFresh, inputsLoaded };
}

/**
 * Run the model tool loop for one phase (explore or diagnose).
 *
 * Returns one of:
 *   { type: 'done_exploring', targetStepId, includeSteps, excludeSteps }
 *   { type: 'escalate', reason }
 *   { type: 'failed', summary, reason }
 *   { type: 'return_to_explore' }   — invalidate fired while in diagnose
 *   { type: 'exhausted' }           — budget ran out
 */
// ── Dev self-postmortem (2026-08-03, user request) ───────────────────────────
// One cache-warm LLM call fired right before compile (the whole explore history
// is already a cached prefix, so it costs pennies): the agent's own account of
// what went well / badly this session, for improving the harness. Saved to
// <charmDir>/self_postmortem.md, shown as a cell in working.wb, and emitted as
// `fairy.self_postmortem` telemetry. Best-effort — never blocks compile.

const SELF_POSTMORTEM_PROMPT =
    '[Development postmortem — exploration is complete; before the clean notebook is compiled, ' +
    'analyse this session as a postmortem for improving this agent.]\n' +
    'Identify what you achieved, where you struggled, which instructions or tools helped, which ' +
    'tools were missing, and what changes would make you more reliable. Focus especially on: ' +
    'failures and their root causes, unclear task intent, tool misuse, unnecessary steps or wasted ' +
    'turns, and opportunities to improve the system prompt, the available tools, the notebook ' +
    'feedback, or memory/context handling.\n' +
    'Respond in JSON only: {"achieved": [...], "struggled": [...], "helped": [...], ' +
    '"missing_tools": [...], "wasted_effort": [...], "recommendations": [...], "lessons": [...]} — ' +
    'arrays of short, concrete, specific strings (max 5 each; reference probe ids like p014 where relevant). ' +
    'Recommendations must be actionable changes to the harness/prompt/tools, not restatements. ' +
    '"lessons" is DIFFERENT and the most valuable field: 0–3 TRANSFERABLE technical lessons that would ' +
    'help on a COMPLETELY DIFFERENT task — a Wolfram Language behaviour, a method-selection rule, or a ' +
    'verification habit. Write them as standalone imperatives with NO probe ids, NO symbol names from this ' +
    'task, and no reference to "this run" (bad: "p004 failed because eigs was symbolic"; good: "Numericize ' +
    'matrices with N[] before Eigenvalues — exact input returns unusable Root[] objects"). If nothing ' +
    'generalises, return an empty lessons array — inventing filler pollutes future runs. ' +
    'Be honest: this report is read by the developers, not graded.';

function renderSelfPostmortem(r) {
    const sec = (title, arr) => (Array.isArray(arr) && arr.length)
        ? `**${title}:**\n${arr.map(x => `- ${String(x)}`).join('\n')}\n`
        : '';
    return [
        '## 🔍 Agent self-postmortem',
        '',
        sec('Achieved', r.achieved),
        sec('Struggled', r.struggled),
        sec('What helped', r.helped),
        sec('Missing tools', r.missing_tools),
        sec('Wasted effort', r.wasted_effort),
        sec('Recommendations', r.recommendations),
    ].filter(Boolean).join('\n');
}

async function runSelfPostmortem({ bus, adapter, binding, messages, signal, spanId, quest, charm, workDir, fsm, M }) {
    const pm = await callOnceWithRetry({
        bus, adapter, binding,
        messages: [...messages, { role: 'user', content: SELF_POSTMORTEM_PROMPT }],
        signal, spanId, prefixSha256: null, quest, charm,
        turnIndex: fsm.turnsUsed, fastCap: 2500,
    });
    M.llmCalls = (M.llmCalls || 0) + 1;
    M.costUSD  = (M.costUSD || 0) + (Number(pm.costUSD) || 0);
    let rep = null;
    try {
        rep = JSON.parse(String(pm.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch (_) {}
    if (!rep || typeof rep !== 'object') return;
    const md = renderSelfPostmortem(rep);
    await fsp.writeFile(path.join(workDir.dir, 'self_postmortem.md'), md, 'utf8').catch(() => {});
    M.selfPostmortem = true;
    // Stage 3: the cross-run LESSONS channel — transferable one-liners go into
    // the grimoire's bounded lessons section and re-enter FUTURE runs' first
    // user message. This is the only write-back path from a run to its successors.
    try {
        const lessonsMod = require('../memory/lessons');
        const gPath = require('../memory/grimoire').grimoireFilePath();
        if (gPath && Array.isArray(rep.lessons) && rep.lessons.length) {
            const res = await lessonsMod.recordLessons(gPath, rep.lessons, quest.id);
            M.lessonsRecorded = res.added;
            if (res.added) {
                await bus.appendEvent('fairy.lessons_recorded', {
                    questId: quest.id, charmId: charm.id, added: res.added, total: res.total,
                    lessons: rep.lessons.filter(lessonsMod.isTransferable).slice(0, 3),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }
        }
    } catch (_) { /* lessons are best-effort — never block the run */ }
    await bus.appendEvent('fairy.self_postmortem', {
        questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
        report: rep, markdown: md.slice(0, 8000),
    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
}

async function runModelTurns({
    phase, messages, fsm, adapter, binding, summaryBinding, bus, signal, spanId, quest, charm, workDir, getWorkingNbDoc,
    steerQueue, recallLive, recallState, metrics, paperTools, literatureLlm, recordSkillGapFn,
    tricksState,
}) {
    const M = metrics || {};  // R10: metric counters (mutated in place)
    const fairySettings = settings.fairy();
    const askSpecialistEnabled = fairySettings.askSpecialistEnabled;
    const askState = { count: 0, cache: new Map(), max: fairySettings.askSpecialistMaxPerCharm };
    const askUser = askSpecialistEnabled
        ? async (question, context) => {
            const timeoutMs = fairySettings.askSpecialistTimeoutSeconds * 1000;
            // createInputBox lets us actively hide the prompt when the deadline
            // expires. Promise.race(showInputBox(), timeout) returned control to
            // Fairy but left the modal visibly stranded on screen.
            if (typeof vscode.window.createInputBox === 'function') {
                return new Promise(resolve => {
                    const box = vscode.window.createInputBox();
                    box.title = 'Fairy asks';
                    box.prompt = question;
                    box.placeholder = context || '';
                    box.ignoreFocusOut = true;
                    let settled = false;
                    let acceptSub;
                    let hideSub;
                    const finish = value => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        try { acceptSub && acceptSub.dispose(); } catch (_) {}
                        try { hideSub && hideSub.dispose(); } catch (_) {}
                        try { box.hide(); box.dispose(); } catch (_) {}
                        resolve(value);
                    };
                    acceptSub = box.onDidAccept(() => finish(box.value));
                    hideSub = box.onDidHide(() => finish(undefined));
                    const timer = setTimeout(() => finish(undefined), timeoutMs);
                    box.show();
                });
            }
            let timer;
            const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
            const dialog = vscode.window.showInputBox({
                title: 'Fairy asks', prompt: question, placeHolder: context || '', ignoreFocusOut: true,
            });
            try { return await Promise.race([dialog, timeout]); }
            finally { if (timer) clearTimeout(timer); }
        }
        : null;
    const fairyCtx = {
        workDir, shim: wolframShim, signal,
        getWorkingNbDoc: getWorkingNbDoc || (() => null),
        askUser,
        askState,
        numericTol: fsm.numeric_tol,   // Stage-2 rung 3: record-time check tolerance
        rejectRedefinition: fairySettings.rejectRedefinition,  // M8
        // cite_skill validation — LIVE array: a late-arriving recall (I12) pushes
        // its ref here so the citation stays valid mid-run.
        recalledSkillRefs: recallLive ? recallLive.refs : [],
        // Stage 3 progressive disclosure: parsed H2 sections of every recalled
        // skill, served on demand by read_skill_section (LIVE map — a late
        // recall registers its sections here mid-run).
        skillSections: recallLive ? recallLive.sections : new Map(),
        paperTools,                                            // research_literature + lit_read
        literatureLlm,                                         // research_literature (optional)
        // Live progress from the literature sub-agent → working.wb status cell, so a
        // long discovery (search rounds + paper reads) shows a thinking stream instead
        // of looking frozen/broken while the tool call blocks.
        emitLiteratureProgress: (p) => {
            try {
                bus.appendEvent('literature.progress', {
                    questId: quest.id, charmId: charm.id,
                    stage: (p && p.stage) || '', detail: (p && p.detail) || '',
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            } catch (_) {}
        },
        // R8: the original task text — research_literature extracts pasted arXiv
        // ids/URLs from it even when the fairy's question omits them.
        taskText: String(charm.task || charm.goal || charm.title || ''),
        fsm,                                                   // I9: read-only (late-lit gate)
        recordSkillGap: recordSkillGapFn || null,              // I20: note_skill_gap tool
        // A3: a skill claim the kernel disproved → revision queue for its author.
        recordSkillCorrection: async ({ skillRef, claim }) => {
            const res = await require('../memory/skillCorrections').recordCorrection({
                skillRef, claim, questId: quest.id, charmId: charm.id,
                contentHash: (recallResult && recallResult.contentHash) || null,
            });
            if (res && res.recorded) {
                bus.appendEvent('skill.contradicted', {
                    questId: quest.id, charmId: charm.id, skillRef, claim: String(claim).slice(0, 300),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }
            return res;
        },
        // Shared BY REFERENCE across the amend path's shallow ctx copy (handleAmendProbe
        // does Object.assign({}, ctx)) — failed-cell replacement bookkeeping lives here.
        _probeState: {},
    };
    const exploreTools = askSpecialistEnabled
        ? EXPLORE_FAIRY_TOOL_SPECS
        : EXPLORE_FAIRY_TOOL_SPECS.filter(t => t.function.name !== 'ask_specialist');
    let budgetReminderInjected = false;
    let lastProbeFailed = false;   // restricts tools to amend/probe/lookup until the failure is fixed
    // KERNEL failure (error/messages/timeout — a ❌ cell exists in the notebook) vs a
    // harness REJECTION (redefinition/near-dup/missing-analysis — nothing was evaluated,
    // nothing to amend). Only kernel failures arm the HARD fix gate: run 23-30-37 wedged
    // 4 turns because a redefinition rejection armed it and then blocked even `chain`.
    let lastProbeKernelFailed = false;
    let lastProbeId = null;        // R1: probeId of the most recent probe (for amend_probe)
    let consecutiveFailures = 0;   // triggers a forced reflection message after 3 in a row
    let findRootNudgeArmed = true; // one method-switch demand per FindRoot failure streak
    // Selective-thinking state (2026-08-01): per-invocation turn counter (phase
    // entry + cadence) and the failure-streak trigger ("several unsuccessful
    // probes in a row → think for one turn"), re-armed after each success.
    const reasoningCfg = settings.fairyReasoning();
    let localTurn = 0;
    let streakThinkPending = false;
    let streakThinkArmed = true;
    // P3: honest effort class from the plan tool (upgradable via revise_plan,
    // never downgradable). trivial → no cadence thinking, no crosscheck deferral.
    let runComplexity = 'standard';
    // P5: cadence thinking is spent where something HAPPENED — armed by
    // failures/invalidates/near-duplicates since the last think turn
    // ('research' plans keep the unconditional drumbeat).
    let eventfulSinceThink = false;
    // P6: ledger re-injection only on change.
    let lastLedgerSha = null;
    // Tricks Tier-B resolution tracking + record-gate hysteresis state.
    let trickResolutionPendingTurn = null;
    let lastRecordGateTurn = -10;
    let consecutiveEssays = 0;   // escalating anti-loop nudge state
    let probesSinceCheckpoint = 0; // nudges the fairy to checkpoint after accumulating sub-results
    let planRecorded = false;      // enforces plan-once-only guard
    let crosscheckNudged = false;  // B7: one-shot done_exploring gate (crosscheck step required)
    let citationNudged = false;    // I16: one-shot cite-or-decline gate for a consulted skill
    let missingDepsNudged = false; // H3: one-shot chain-completeness gate (unrecorded definers)
    const rebuildCounts = {};      // M9: symbol → # of times rebuilt without recording
    const REBUILD_THRESHOLD = 3;   // M9: nudge after this many rebuilds of one symbol
    // R4: track clean, symbol-defining probes that were not yet recorded/amended.
    // { probeId, symbol, turnSeen, nudged } — nudge once if unrecorded after 2 turns.
    const pendingRecords = [];
    // R1/R7: amend bookkeeping. The first FREE_AMENDS amends of a given probe are free.
    let amendsUsedForCurrentProbe = 0;
    const FREE_AMENDS = 2;
    // Forced-fix window: while a probe is failed and fewer than this many amends have
    // been tried on it, the toolset is narrowed to amend_probe+lookup (fix in place).
    const FIX_AMEND_ATTEMPTS = 3;
    // Reasoning-overrun protection (run 16-30-00): strike-disable + cooldown.
    let thinkingDisabledForRun = false;
    let reasoningOverruns = 0;
    let lastThinkAtTurn = -1;
    const THINK_COOLDOWN_TURNS = 6;
    // P4: auto-checkpoint after every AUTO_CHECKPOINT_EVERY records (a budget-overrun safety net).
    let recordsSinceCheckpoint = 0;
    const AUTO_CHECKPOINT_EVERY = 3;
    // R10: record-rate soft gate — force a consolidation turn when unrecorded clean
    // results pile up. Cooling flag prevents a hard lock across consecutive turns.
    // R11: capped + higher threshold — at 4/turn-12 it became a nuisance (run Q_QQHP45)
    // that nagged without lifting the record rate (the agent was thrashing on the math,
    // not merely forgetting to record). A few firm nudges, then leave the agent alone.
    let recordGateCoolingDown = false;
    const RECORD_GATE_THRESHOLD = 4;
    // Raised 3→5 now that record/note_fact clears only the MATCHING backlog
    // entries: the gate re-fires on genuinely unrecorded work instead of
    // re-nagging about a backlog that one record used to (wrongly) wipe.
    const MAX_RECORD_GATES = 8;   // 5→8 (run 13-30-18: all 5 spent mid-run, then unrecorded probing resumed unchecked)

    // O11: run-level caps, enforced cooperatively HERE (the RunManager emits
    // budget.exhausted but nothing in this loop observed it). An 8-call reserve is
    // kept for the partial-report phase so a cap-hit degrades to a partial
    // deliverable, not a dead run. `metrics.runCapBonus` is raised when the user
    // chooses to continue past exhaustion.
    let runCaps = { runUSD: 0, runLlmCalls: 0 };
    try { runCaps = settings.runBudget() || runCaps; } catch (_) {}
    // Run-LEVEL usage from the telemetry bus (per-run buffer, cleared on beginRun).
    // In a multi-charm run the cap is consumed ACROSS charms, so the per-charm
    // counter (M.llmCalls) never reaches the reserve threshold — run Q25's charm 3
    // overshot the RunManager cap by 24 calls and shipped without review. A
    // `budget.effective` event (Director budget overrides) takes precedence over
    // the settings caps; a RunManager `budget.exhausted` stops the loop within
    // one turn regardless of counters.
    const runLevelUsage = () => {
        let calls = 0, cost = 0, exhausted = false, effective = null;
        try {
            for (const ev of bus.recent(10000)) {
                if (ev.type === 'llm.call') {
                    calls += 1;
                    cost  += Number(ev.payload && ev.payload.costUSD) || 0;
                } else if (ev.type === 'budget.effective' && ev.payload) {
                    effective = ev.payload;
                } else if (ev.type === 'budget.exhausted' && ev.payload
                           && String(ev.payload.kind || '').startsWith('run_')
                           && ev.payload.scope !== 'fairy_loop') {
                    exhausted = true;
                }
            }
        } catch (_) {}
        return { calls, cost, exhausted, effective };
    };
    const overRunCap = () => {
        const run = runLevelUsage();
        if (run.exhausted) return 'run_budget_event';
        const caps = run.effective || runCaps;
        const bonus   = M.runCapBonus || 0;
        const callCap = Number(caps.runLlmCalls) > 0 ? Number(caps.runLlmCalls) + bonus : 0;
        const usdCap  = Number(caps.runUSD) > 0 ? Number(caps.runUSD) * (1 + bonus / 60) : 0;
        const calls = Math.max(M.llmCalls || 0, run.calls);
        const cost  = Math.max(M.costUSD  || 0, run.cost);
        if (callCap > 0 && calls >= Math.max(4, callCap - 8)) return 'run_llm_calls';
        if (usdCap  > 0 && cost  >= usdCap)                   return 'run_usd';
        return null;
    };
    let capEventEmitted = false;

    const canContinue = () => {
        if (!fsm.canTurn()) return false;
        if (phase === 'diagnose' && !fsm.canDiagnoseTurn()) return false;
        return true;
    };

    while (canContinue()) {
        // O11: cap check before spending another LLM call.
        const capHit = overRunCap();
        if (capHit) {
            if (!capEventEmitted) {
                capEventEmitted = true;
                M.runCapHits = (M.runCapHits || 0) + 1;
                bus.appendEvent('budget.exhausted', {
                    kind: capHit, scope: 'fairy_loop',
                    llmCalls: M.llmCalls || 0, costUSD: M.costUSD || 0,
                    message: `Run-level cap (${capHit}) reached inside the fairy loop — routing to partial report.`,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }
            return { type: 'exhausted' };
        }

        // O6: compact when the context grows past a size budget, not on a fixed
        // turn count. Skip while the last message is an unanswered assistant
        // tool_calls (must never compact mid tool-call/response pair).
        const lastMsg = messages[messages.length - 1];
        const lastIsPendingCalls = lastMsg && lastMsg.role === 'assistant'
            && Array.isArray(lastMsg.tool_calls) && lastMsg.tool_calls.length > 0;
        const contextChars = estimateContextChars(messages);
        // O3: compact at context PRESSURE, not early. With cached input pricing a
        // long stable prefix is cheaper than repeated compaction, and each compaction
        // is an information cliff.
        //
        // Trigger authority (2026-08-01): model-reported input tokens of the
        // PREVIOUS call (exact); the char estimate is only a first-turn
        // fallback (chars/token ≈ 1.0 on math-dense WL, not the 4 the old
        // chars-only budget assumed).
        //
        // Budget (A/B-tested same day, runs baseline3-hard vs baseline4-hard):
        // compacting mid-run at 100k tokens on a 1M-context model was a NET
        // LOSS — cache hit 0.93→0.82, probes 25→49 (the digest is an
        // information cliff: the model re-explored), cost $0.21→$0.25. Cached
        // input is ~100× cheaper than output, so on big-context models
        // compaction is a last-resort safety net, not an optimisation: 60% of
        // the window, capped at 400k tokens (128k-ctx models still compact
        // around 77k).
        const COMPACT_TOKEN_BUDGET = Math.min(
            Math.max(20000, (binding.contextWindow || 128000) * 0.6),
            400000);
        const lastInputTokens = M.lastInputTokens || 0;
        const overBudget = lastInputTokens > 0
            ? lastInputTokens > COMPACT_TOKEN_BUDGET
            : contextChars > COMPACT_TOKEN_BUDGET * 4;
        if (!lastIsPendingCalls && fsm.turnsUsed > 0 && overBudget) {
            messages = await compactMessages(messages, 6, adapter, summaryBinding, bus, spanId, quest, charm, workDir);
            M.lastInputTokens = 0;   // re-measure from the next call
            bus.appendEvent('fairy.history_compacted', {
                questId: quest.id, charmId: charm.id, turnsCompacted: fsm.turnsUsed,
                contextCharsBefore: contextChars, lastInputTokens,
                tokenBudget: COMPACT_TOKEN_BUDGET,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        }

        // I12: late recall injection — the skill search resolved after run start.
        // Inject the reference block and/or the gap list once, at the next turn
        // boundary (each gated separately: the fast path may have shown one already).
        if (phase === 'explore' && recallLive) {
            const wantBlock = !recallLive.injected && recallLive.block;
            const wantGaps  = !recallLive.gapsShown && recallLive.gaps && recallLive.gaps.length;
            if (wantBlock || wantGaps) {
                const parts = [];
                if (wantBlock) {
                    recallLive.injected = true;
                    parts.push('[A relevant SkilXiv skill arrived after run start — read it before deriving ' +
                        'the same method from scratch. If you have already covered this ground, continue.]\n' +
                        recallLive.block);
                }
                if (wantGaps) {
                    recallLive.gapsShown = true;
                    parts.push('[Known skill gaps — the registry has NO skill for: ' +
                        recallLive.gaps.join('; ') +
                        '. Derive these cleanly (record/note_fact) — a delivered run banks them as candidate new skills.]');
                }
                appendToLastToolOrUser(messages, parts.join('\n\n'));
                bus.appendEvent('fairy.recall_late_injected', {
                    questId: quest.id, charmId: charm.id,
                    skillRef: recallLive.refs[recallLive.refs.length - 1] || null,
                    gaps: wantGaps ? recallLive.gaps : [],
                    turnsUsed: fsm.turnsUsed,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }
        }

        // Drain one steering message per turn (newest user directive goes first).
        if (phase === 'explore' && steerQueue) {
            const steerText = steerQueue.drain();
            if (steerText) {
                messages.push({ role: 'user', content: `[User steering]: ${steerText}` });
                bus.appendEvent('fairy.steer', {
                    questId: quest.id, charmId: charm.id, text: steerText,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }
        }

        // Preserve progress early, then remind every three probes while the backlog grows.
        if (phase === 'explore' && probesSinceCheckpoint >= 6 && probesSinceCheckpoint % 3 === 0) {
            appendToLastToolOrUser(messages,
                '[System: You have accumulated significant results without checkpointing. ' +
                'Consider calling `chain` to review, then `checkpoint` to commit the completed sub-results ' +
                'before continuing. This preserves your progress if the budget runs out.]');
        }

        // M7: every 5 turns, surface the live kernel symbol table so the model calls
        // existing symbols by name instead of defensively rebuilding them.
        // R2: also surface the established-results ledger so it does not re-derive facts.
        // P6 (2026-08-02): inject only when CHANGED — each verbatim re-injection
        // lived in history forever (pure token noise once stable).
        if (phase === 'explore' && fsm.turnsUsed > 0 && fsm.turnsUsed % 5 === 0) {
            const [symbolTable, factsLedger] = await Promise.all([
                workDir.buildSymbolTable({ maxChars: 1200 }).catch(() => ''),
                workDir.buildFactsLedger({ maxChars: 1200 }).catch(() => ''),
            ]);
            const ledgerSha = sha256(symbolTable + '' + factsLedger);
            if (ledgerSha === lastLedgerSha) {
                // unchanged — skip both injections this round
            } else {
            lastLedgerSha = ledgerSha;
            if (symbolTable) {
                appendToLastToolOrUser(messages,
                    '[Kernel symbols currently defined — call these BY NAME, do NOT redefine them:\n' +
                    symbolTable + '\n]');
            }
            if (factsLedger) {
                appendToLastToolOrUser(messages,
                    '[Established results — do NOT recompute these; reference by key:\n' +
                    factsLedger + '\n]');
            }
            }
        }

        // R4: nudge to record a clean, symbol-defining probe left unrecorded for 2+ turns.
        // Capped per run (2026-08-01, run baseline4-hard: 27 firings on one charm — on
        // an exploration-heavy task the per-probe nudges become a drumbeat that adds
        // prompt noise without changing behaviour; the record_gate is the real backstop).
        if (phase === 'explore' && pendingRecords.length && (M.unrecordedNudges || 0) < 6) {
            for (const p of pendingRecords) {
                if (!p.nudged && (fsm.turnsUsed - p.turnSeen) >= 3) {
                    p.nudged = true;
                    M.unrecordedNudges = (M.unrecordedNudges || 0) + 1;
                    bus.appendEvent('fairy.unrecorded_success', {
                        questId: quest.id, charmId: charm.id, probeId: p.probeId, symbol: p.symbol,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    appendToLastToolOrUser(messages,
                        `[System: probe ${p.probeId} produced a clean result defining \`${p.symbol}\` ` +
                        'but you have not recorded it. Record it in THIS reply alongside your next probe ' +
                        '(batch the two tool calls), or avoid the problem entirely by attaching ' +
                        '`record: {stepId, checks}` to trusted probes — unrecorded results are lost.]');
                    if ((M.unrecordedNudges || 0) >= 6) break;
                }
            }
        }

        if (phase === 'explore' && !budgetReminderInjected && fsm.exploreProbesRemaining <= 3) {
            budgetReminderInjected = true;
            appendToLastToolOrUser(messages, buildBudgetReminderMessage({
                exploreProbesRemaining: fsm.exploreProbesRemaining,
                backtracksRemaining:    fsm.backtracksRemaining,
            }));
        }

        // After a failed probe, restrict tool choice. The first FIX_AMEND_ATTEMPTS fix
        // turns offer ONLY amend_probe + lookup — the agent must repair the failing cell
        // in place (it stays visible in working.wb with its error until amended); only
        // after that many attempts does the full failed-set (incl. probe) return as the
        // exit ramp for a genuinely different approach. (2026-08-02: was 1 attempt, which
        // let the agent abandon broken calculations after a single token fix try.)
        //
        // R10 record-rate soft gate: if NOT in a failed-probe fix and too many clean,
        // symbol-defining probes are piling up unrecorded, force ONE consolidation turn
        // (record/note_fact/chain/invalidate only). Cool down for a turn afterwards so the
        // agent can't be hard-locked (e.g. if it only calls chain).
        let activeTools;
        if (phase === 'explore' && lastProbeFailed) {
            // Kernel failures get the narrow fix offer (amend+lookup); harness
            // rejections (redefinition/near-dup) get the full failed-set — their
            // remedy is often a REVISED FRESH probe, which amend-only mis-offers.
            activeTools = (lastProbeKernelFailed && amendsUsedForCurrentProbe < FIX_AMEND_ATTEMPTS)
                ? FAILED_PROBE_FIX_TOOL_SPECS : FAILED_PROBE_TOOL_SPECS;
            recordGateCoolingDown = false;
        } else if (phase === 'explore' && !recordGateCoolingDown && (M.recordGates || 0) < MAX_RECORD_GATES && pendingRecords.length >= RECORD_GATE_THRESHOLD
            // Hysteresis (run 13-30-18: gate fired 5× in 17 calls): after a
            // gate turn, wait ≥3 turns before re-firing even if the backlog
            // has not drained — repeated pauses without progress just burn turns.
            && (fsm.turnsUsed - lastRecordGateTurn) >= 3) {
            activeTools = RECORD_GATE_TOOL_SPECS;
            recordGateCoolingDown = true;
            lastRecordGateTurn = fsm.turnsUsed;
            M.recordGates = (M.recordGates || 0) + 1;
            bus.appendEvent('fairy.record_gate', {
                questId: quest.id, charmId: charm.id, unrecorded: pendingRecords.length,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            // Enumerate the backlog (run 23-30-37: 8 gates fired but ~1 record per
            // gate — a bare count gives the model nothing to copy from).
            const backlog = pendingRecords.slice(0, 8)
                .map(p => `${p.probeId}${p.symbol ? ` (defines \`${p.symbol}\`)` : ''}`)
                .join(', ');
            appendToLastToolOrUser(messages,
                `[System: ${pendingRecords.length} clean results are unrecorded: ${backlog}. ` +
                'CONSOLIDATE NOW — emit ALL the needed `record` calls in ONE reply, one per probeId ' +
                'above (each may carry `checks` for machine verification), plus `note_fact` values ' +
                'or `invalidate` dead ends. Probing is paused this turn until you commit results. ' +
                'Going forward, attach `record: {stepId, checks}` directly to probes you trust — ' +
                'it commits in the same call.]');
        } else {
            activeTools = exploreTools;
            recordGateCoolingDown = false;
        }

        fsm.incrementTurn();
        // Selective thinking (2026-08-01): full auto-think is suppressed at the
        // adapter; instead deliberate reasoning turns fire on phase entry (the
        // planning turn), on a cadence, and after a probe-failure streak — the
        // judgment moments, not the mechanical ones.
        const _rcfg = reasoningCfg;
        const cadenceDue = _rcfg.cadence > 0 && localTurn > 0 && localTurn % _rcfg.cadence === 0;
        const thinkTurn = _rcfg.cadence !== 0 && runComplexity !== 'trivial'
            // I1 (run baselineff): hard per-run cap — failure-heavy runs armed
            // a think turn per streak, unbounded (18 thinks, 78% of output).
            && (M.thinkingTurns || 0) < _rcfg.maxPerRun
            // Strike-disable (run 16-30-00): after 2 reasoning overruns (think
            // turns truncated at the cap with ZERO output) thinking is OFF for
            // the rest of the run — a model that diverges twice will keep
            // diverging, and each overrun costs a full output cap + a retry.
            && !thinkingDisabledForRun
            // Cooldown (run 16-30-00: 5 thinks in the first ~15 turns, back to
            // back): at least THINK_COOLDOWN_TURNS between deliberate thinks.
            && (lastThinkAtTurn < 0 || (fsm.turnsUsed - lastThinkAtTurn) >= THINK_COOLDOWN_TURNS)
            && (
            (_rcfg.onPhaseEntry && localTurn === 0) ||
            // P5: on 'standard' runs the cadence think fires only when something
            // eventful (failure/invalidate/near-dup) happened since the last one;
            // 'research' keeps the unconditional drumbeat.
            (cadenceDue && (runComplexity === 'research' || eventfulSinceThink)) ||
            streakThinkPending
        );
        if (thinkTurn) {
            M.thinkingTurns = (M.thinkingTurns || 0) + 1;
            lastThinkAtTurn = fsm.turnsUsed;
            if (streakThinkPending) streakThinkPending = false;
            eventfulSinceThink = false;
        }
        localTurn++;
        // Slim reflection context (cache-miss economics): think turns get
        // [system, task, state digest, recent tail] instead of full history.
        let thinkContext = null;
        if (thinkTurn) {
            let digest = '';
            try {
                const [st, fl] = await Promise.all([
                    workDir.buildSymbolTable({ maxChars: 1200 }).catch(() => ''),
                    workDir.buildFactsLedger({ maxChars: 1200 }).catch(() => ''),
                ]);
                digest = [st && `Kernel symbols:\n${st}`, fl && `Established results:\n${fl}`]
                    .filter(Boolean).join('\n\n');
            } catch (_) {}
            thinkContext = buildThinkContext(messages, digest);
        }
        const result = await callOnceWithRetry({
            bus, adapter, binding, messages, tools: activeTools,
            signal, spanId, prefixSha256: null, quest, charm,
            turnIndex: fsm.turnsUsed,
            thinkTurn, thinkEffort: _rcfg.effort,
            // Run 16-30-00: the 12000 boost (→24k runway) just let diverging
            // thinks run 5 minutes each before truncating empty. Polish has
            // used 6000 (→18k) with zero overruns — match it; standard tasks
            // get less. Divergence itself is handled by strike-disable; after
            // the FIRST overrun the boost drops to 0 (base cap) — the 2026-08-03
            // sweep still paid 1–2 overruns per research run at full boost.
            thinkBoost: reasoningOverruns > 0 ? 0 : (runComplexity === 'research' ? 6000 : 4000),
            fastCap: 4000,
            thinkContext,
        });

        if (signal && signal.aborted) throw new Error('aborted');

        // Accumulate run cost for the live status line.
        M.costUSD  = (M.costUSD || 0) + (Number(result.costUSD) || 0);
        M.llmCalls = (M.llmCalls || 0) + 1;   // O11: cooperative run-cap counter
        // O3: prompt-cache effectiveness (deepseek: prompt_cache_hit/miss_tokens;
        // anthropic: cache_read_input_tokens). Providers without caching count all
        // input as miss, which is the honest hit-rate denominator.
        {
            const u = result.usage || {};
            M.cacheRead = (M.cacheRead || 0) + (Number(u.cacheReadTokens) || 0);
            M.cacheMiss = (M.cacheMiss || 0) + (u.cacheMissTokens != null
                ? (Number(u.cacheMissTokens) || 0)
                : Math.max(0, (Number(u.inputTokens) || 0) - (Number(u.cacheReadTokens) || 0)));
            // Exact prompt size of this turn — the compaction trigger's authority
            // (char estimates undercount math-dense WL by ~4×).
            M.lastInputTokens = Number(u.inputTokens) || 0;
            if (result.stopReason === 'length') M.lengthStops = (M.lengthStops || 0) + 1;
            if (result.lengthStopRecovered)     M.lengthStopRecoveries = (M.lengthStopRecoveries || 0) + 1;
        }
        // Strike-disable: two think turns truncated with zero output → thinking
        // OFF for the rest of the run (each overrun costs a full output cap +
        // a retry turn; run 16-30-00 burned 4×24k tokens this way).
        if (result.reasoningOverrun) {
            reasoningOverruns++;
            M.reasoningOverruns = reasoningOverruns;
            if (reasoningOverruns >= 2 && !thinkingDisabledForRun) {
                thinkingDisabledForRun = true;
                bus.appendEvent('omen', {
                    kind: 'thinking_disabled',
                    message: `Thinking disabled for the rest of the run after ${reasoningOverruns} reasoning overruns (think turns truncated at the cap with no output).`,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }
        }

        // P7: live status — stream phase, remaining budget, cost/probes/turns, and the
        // tail of the model's reasoning into a pinned working.wb cell (throttled in UI).
        if (phase === 'explore') {
            bus.appendEvent('fairy.status', {
                questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
                phase, budgetLeft: fsm.exploreProbesRemaining,
                probesUsed: (M.probesOk || 0) + (M.probesFailed || 0),
                turnsUsed: fsm.turnsUsed,
                costUSD: M.costUSD,
                thinkingTail: reasoningTail(result.content || '', 3),
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        }

        const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];

        if (calls.length > 0) {
            messages.push({
                role: 'assistant',
                content: result.content || '',
                // No reasoning_content in history: V4's thinking-mode round-trip
                // demand applies only when the request TAIL is an assistant/tool
                // run — callOnce appends a reflection user message to every
                // thinking request, which lifts the requirement entirely
                // (empirically mapped 2026-08-02). History stays lean.
                tool_calls: calls.map(c => ({
                    id: c.id, type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
                })),
            });

            for (const call of calls) {
                const callArgs = call.arguments || {};
                const correlationId = 'cor_' + crypto.randomBytes(6).toString('hex');

                // P1 (batched turns): a record emitted in the SAME turn as its
                // probe can't know the fresh probeId — "last" (or omission)
                // binds to the most recent probe of this run.
                if (call.name === 'record' && (!callArgs.probeId || callArgs.probeId === 'last') && lastProbeId) {
                    callArgs.probeId = lastProbeId;
                }

                await bus.appendEvent('tool.call', {
                    correlationId, name: call.name, args: truncateArgsForUi(callArgs),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

                // Budget guard: probe
                if (call.name === 'probe' && !fsm.canProbe()) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:          'probe budget exhausted',
                            suggestedAction: 'Emit done_exploring with your current chain (and excludeSteps for any redundant steps), or call finalize if the chain cannot produce the requested result.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'probe_budget_exhausted',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    continue;
                }

                // I20: note_skill_gap capped at 2/run.
                if (call.name === 'note_skill_gap' && (M.skillGapNotes || 0) >= 2) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:   'note_skill_gap cap reached (2 per run).',
                            suggestedAction: 'Continue with the task — the recorded gaps are already filed.',
                        }) });
                    continue;
                }

                // Guard: plan may only be called once
                if (call.name === 'plan' && planRecorded) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:   'plan has already been recorded for this run — to change the roadmap call `revise_plan` (max 2/run) with the evidence that invalidated it',
                            suggestedAction: 'Proceed with your existing plan. Call probe to start computing.',
                        }) });
                    continue;
                }

                // Budget guard: invalidate
                if (call.name === 'invalidate' && !fsm.canBacktrack()) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:          'backtrack budget exhausted — invalidate is now blocked',
                            suggestedAction: 'Emit done_exploring with your current chain. If two steps define the same symbol, list the redundant step in excludeSteps. Only call finalize(escalate) if the chain is semantically broken and cannot produce the requested result at all.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'backtrack_budget_exhausted',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    continue;
                }

                // HARD toolset enforcement for the failed-probe fix window (run
                // 23-01-18: after a failed amend of p014 the model simply called
                // `probe` p015 and the dispatcher ran it — the narrowed toolset
                // offer is only advisory to the model). While the last probe is
                // KERNEL-failed (a ❌ cell exists) and fix attempts remain, only
                // the fix tools plus read-only/bookkeeping tools execute — record/
                // note_fact/inspect/chain touch EARLIER results and never conflict
                // with fixing the current cell (run 23-30-37: blocking them wedged
                // the run for 4 turns). Checked per CALL, not per turn, so a
                // batched reply that fixes the cell first (amend ok →
                // lastProbeKernelFailed=false) may legitimately continue with probes.
                if (phase === 'explore' && lastProbeKernelFailed
                    && amendsUsedForCurrentProbe < FIX_AMEND_ATTEMPTS
                    && !['amend_probe', 'lookup', 'record', 'note_fact', 'inspect', 'chain'].includes(call.name)) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason: `Probe ${lastProbeId} FAILED and its ❌ cell is still in the notebook. ` +
                                `Until it is fixed, only amend_probe/lookup (the fix) and record/note_fact/inspect/chain ` +
                                `(bookkeeping of EARLIER results) are accepted ` +
                                `(${FIX_AMEND_ATTEMPTS - amendsUsedForCurrentProbe} fix attempt(s) remaining).`,
                            suggestedAction: `Fix the failing cell IN PLACE: call amend_probe with the corrected code for ${lastProbeId} ` +
                                '(it replaces the ❌ cell and re-runs it in one go). Use lookup first if you need the correct syntax/options.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'toolset_restricted_fix_pending',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    M.fixGateRejections = (M.fixGateRejections || 0) + 1;
                    continue;
                }

                // R1: expose the last probe to amend_probe so it can reuse the slot.
                fairyCtx.lastProbeId     = lastProbeId;
                fairyCtx.lastProbeFailed = lastProbeId ? lastProbeFailed : false;

                const toolResult = await dispatchFairyTool({ name: call.name, args: callArgs }, fairyCtx);

                // ── Stage C1 (2026-08-04): GATE REJECTION TELEMETRY ──────────
                // Invariant: a gate without rejection telemetry is a silent
                // capability loss waiting to happen. Both losses this week (the
                // fix gate blocking bookkeeping; the recall fast-path skipping
                // research tasks) were invisible for days because the rejection
                // was returned to the model and never recorded anywhere.
                // ONE emitter here covers every present and FUTURE gate: any
                // tool result that is a harness REJECTION (not a kernel failure)
                // lands in `fairy.gate_rejected` + a run_metrics histogram.
                if (toolResult && toolResult.ok === false && !KERNEL_FAIL_KINDS.has(toolResult.kind)) {
                    const gk = String(toolResult.kind || 'unknown');
                    M.gateRejections = M.gateRejections || {};
                    M.gateRejections[gk] = (M.gateRejections[gk] || 0) + 1;
                    bus.appendEvent('fairy.gate_rejected', {
                        questId: quest.id, charmId: charm.id,
                        tool: call.name, gate: gk,
                        reason: String(toolResult.error || toolResult.summary || '').slice(0, 300),
                        turnsUsed: fsm.turnsUsed,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }

                // Post-dispatch: consume probe budget, track failure state, checkpoint/plan counters
                if (call.name === 'plan') {
                    if (toolResult.ok !== false) {
                        planRecorded = true;
                        let planPayload = {};
                        try { planPayload = JSON.parse(toolResult.modelPayload || '{}'); } catch (_) {}
                        // P3 (effort scaling): honest complexity from the plan
                        // shapes the harness — trivial tasks skip reflection
                        // cadence and the crosscheck deferral (validation checks
                        // + fresh-kernel replay still apply in full).
                        const cx = String((callArgs && callArgs.complexity) || '').toLowerCase();
                        if (['trivial', 'standard', 'research'].includes(cx)) {
                            runComplexity = cx;
                            charm._complexity = cx;   // polish/partial loops read this (I5)
                            if (cx === 'trivial') crosscheckNudged = true;   // no deferral loop on trivia
                        }
                        bus.appendEvent('plan.created', {
                            questId:  quest.id,
                            charmId:  charm.id,
                            charmDir: workDir.dir,
                            steps:    planPayload.steps  || (callArgs && callArgs.steps) || [],
                            note:     planPayload.note   || (callArgs && callArgs.note)  || '',
                            complexity: runComplexity,
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    }
                }
                // O7: a plan revision posts an updated roadmap cell (revision > 0).
                if (call.name === 'revise_plan' && toolResult.ok !== false) {
                    let rp = {};
                    try { rp = JSON.parse(toolResult.modelPayload || '{}'); } catch (_) {}
                    M.planRevisions = (M.planRevisions || 0) + 1;
                    // P3: complexity may be UPGRADED mid-run, never downgraded.
                    const order = { trivial: 0, standard: 1, research: 2 };
                    const newCx = String((callArgs && callArgs.complexity) || '').toLowerCase();
                    if (order[newCx] !== undefined && order[newCx] > (order[runComplexity] ?? 1)) {
                        runComplexity = newCx;
                        charm._complexity = newCx;
                    }
                    bus.appendEvent('plan.created', {
                        questId:  quest.id,
                        charmId:  charm.id,
                        charmDir: workDir.dir,
                        steps:    rp.steps || (callArgs && callArgs.steps) || [],
                        note:     (callArgs && callArgs.changes) || '',
                        revision: rp.revision || 1,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }
                if (call.name === 'checkpoint' && toolResult.ok !== false) {
                    probesSinceCheckpoint = 0;
                    recordsSinceCheckpoint = 0;   // P4: explicit checkpoint resets the auto counter
                    let cpPayload = {};
                    try { cpPayload = JSON.parse(toolResult.modelPayload || '{}'); } catch (_) {}
                    bus.appendEvent('checkpoint.recorded', {
                        questId:       quest.id,
                        charmId:       charm.id,
                        charmDir:      workDir.dir,
                        sectionTitle:  cpPayload.sectionTitle  || (callArgs && callArgs.sectionTitle) || '',
                        stepsIncluded: cpPayload.stepsIncluded || (callArgs && callArgs.stepIds)      || [],
                        note:          (callArgs && callArgs.note) || '',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }

                if (call.name === 'define_util' && (toolResult.kind === 'util_fork' || toolResult.kind === 'util_cap')) {
                    M.utilForkRejections = (M.utilForkRejections || 0) + 1;   // P10
                }
                // P6: trace every registered util into working.wb so the user sees the spine.
                if (call.name === 'define_util' && toolResult.ok !== false) {
                    const uName = (callArgs && callArgs.name) || '';
                    // M9: feed util re-derivation into the repeat-abandon counter.
                    if (uName) {
                        rebuildCounts[uName] = (rebuildCounts[uName] || 0) + 1;
                    }
                    bus.appendEvent('util.registered', {
                        questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
                        name: uName, note: (callArgs && callArgs.note) || '', code: (callArgs && callArgs.code) || '',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }
                // Near-duplicate rejection: no probe was spent, so do NOT count it as a
                // failure or reset the amend cycle. Set lastProbeFailed so the next turn
                // offers the amend/lookup gate — which is exactly the remedy (revise the
                // last real probe in place instead of re-pasting it).
                if (call.name === 'invalidate' && toolResult.ok !== false) eventfulSinceThink = true;
                if (call.name === 'probe' && toolResult.kind === 'near_duplicate') {
                    eventfulSinceThink = true;
                    M.nearDuplicateRejections = (M.nearDuplicateRejections || 0) + 1;
                    lastProbeFailed = true;
                    bus.appendEvent('fairy.near_duplicate', {
                        questId: quest.id, charmId: charm.id, lastProbeId,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                } else if (call.name === 'probe') {
                    // R1: a fresh probe starts a new amend cycle.
                    lastProbeId = toolResult.probeId || lastProbeId;
                    amendsUsedForCurrentProbe = 0;
                    if (toolResult.ok !== false) {
                        lastProbeFailed = false;
                        lastProbeKernelFailed = false;
                        consecutiveFailures = 0;
                        streakThinkArmed = true;   // a success re-arms the streak-thinking trigger
                        findRootNudgeArmed = true;
                        probesSinceCheckpoint++;
                        M.probesOk = (M.probesOk || 0) + 1;
                        // Tricks resolution signal: a success within 3 turns of a
                        // shown trick counts as resolved (the curation metric).
                        if (trickResolutionPendingTurn !== null && (fsm.turnsUsed - trickResolutionPendingTurn) <= 3) {
                            M.tricksResolved = (M.tricksResolved || 0) + 1;
                            trickResolutionPendingTurn = null;
                        }
                        try { fsm.consumeProbe(); } catch (_) {}

                        // M9: repeat-and-abandon detection. If the model keeps redefining
                        // the same symbol without recording, it is rebuilding, not extending.
                        // (Multi-cell probes expose the last executed cell's code.)
                        const targetSym = extractTargetSymbol((callArgs && callArgs.code) || toolResult.lastCellCode || '');
                        if (targetSym) {
                            rebuildCounts[targetSym] = (rebuildCounts[targetSym] || 0) + 1;
                            if (rebuildCounts[targetSym] >= REBUILD_THRESHOLD) {
                                M.repeatAbandon = (M.repeatAbandon || 0) + 1;
                                bus.appendEvent('fairy.repeat_abandon', {
                                    questId: quest.id, charmId: charm.id,
                                    symbol: targetSym, count: rebuildCounts[targetSym],
                                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                                appendToLastToolOrUser(messages,
                                    `[System: you have rebuilt \`${targetSym}\` ${rebuildCounts[targetSym]} times ` +
                                    'without recording it. Either record the working version now and build forward ' +
                                    'on it, or invalidate and move to the next sub-problem. Do NOT rebuild ' +
                                    `\`${targetSym}\` from scratch again.]`);
                                rebuildCounts[targetSym] = 0;  // reset so we don't nudge every probe
                            }
                            // R4: this clean probe defines a symbol — track it as a pending record.
                            // P2: unless the probe AUTO-RECORDED itself (record: arg), in which
                            // case it is already a step and never becomes record-pressure.
                            if (toolResult.autoRecorded) {
                                M.autoRecords = (M.autoRecords || 0) + 1;
                                recordsSinceCheckpoint++;
                                for (let pi = pendingRecords.length - 1; pi >= 0; pi--) {
                                    if (pendingRecords[pi].symbol === targetSym) pendingRecords.splice(pi, 1);
                                }
                            } else {
                                const probeId = toolResult.probeId || '';
                                const existing = pendingRecords.find(p => p.probeId === probeId || p.symbol === targetSym);
                                if (existing) {
                                    existing.probeId = probeId;
                                    existing.symbol = targetSym;
                                    existing.turnSeen = fsm.turnsUsed;
                                    existing.nudged = false;
                                } else {
                                    pendingRecords.push({ probeId, symbol: targetSym, turnSeen: fsm.turnsUsed, nudged: false });
                                }
                            }
                        }

                        // NOTE: skill "use" is no longer inferred from probe tokens — that
                        // produced false positives (e.g. a probe calling Range[] "using" any
                        // skill whose text contains "Range"). Use is now declared explicitly
                        // by the agent via the cite_skill tool. See the cite_skill post-dispatch.
                        bus.appendEvent('fairy.budget', {
                            questId: quest.id, charmId: charm.id,
                            budget: fsm.getBudgetStatus(),
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                        // Signal the UI to append a live cell (with output) to working.wb.
                        bus.appendEvent('probe.appended', {
                            questId: quest.id, charmId: charm.id,
                            charmDir: workDir.dir,
                            probeId:  toolResult.probeId || '',
                            code:     (callArgs && callArgs.code) || toolResult.lastCellCode || '',
                            note:     (callArgs && callArgs.note) || '',
                            value:    (toolResult.raw && toolResult.raw.value) || '',
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    } else {
                        // Probe failed — lock tools to amend/probe/lookup until fixed.
                        lastProbeFailed = true;
                        // Only a KERNEL failure (a ❌ cell exists to amend) arms the hard
                        // fix gate; harness rejections (redefinition/syntax/…) don't.
                        lastProbeKernelFailed = KERNEL_FAIL_KINDS.has(toolResult.kind);
                        M.probesFailed = (M.probesFailed || 0) + 1;
                        consecutiveFailures++;
                        eventfulSinceThink = true;
                        // Tricks Tier B (2026-08-02): deterministic signature match
                        // against the kernel messages/error — the tip arrives in the
                        // same turn the model reads the failure. ≤2 tricks, each
                        // shown ≤2×/run.
                        if (tricksState && tricksState.list.length) {
                            const raw = toolResult.raw || {};
                            // matchedAll = does ANY trick cover this signature (regardless
                            // of per-run show caps). The growth ledger must key off THIS —
                            // filtering by the show cap first made already-covered
                            // signatures look unmatched (Thread::tdlen logged 15× despite
                            // having a trick, poisoning the Phase-2 promotion queue).
                            const matchedAll = tricksMod.matchTricks(tricksState.list, {
                                messages: raw.messages, error: toolResult.error,
                                code: (callArgs && callArgs.code) || toolResult.lastCellCode || '', kind: toolResult.kind,
                            });
                            const matched = matchedAll.filter(t => (tricksState.shown[t.id] || 0) < tricksMod.MAX_SHOWS_PER_TRICK);
                            for (const t of matched) {
                                tricksState.shown[t.id] = (tricksState.shown[t.id] || 0) + 1;
                                M.tricksShown = (M.tricksShown || 0) + 1;
                                appendToLastToolOrUser(messages, tricksMod.renderTrick(t));
                                bus.appendEvent('fairy.trick_shown', {
                                    questId: quest.id, charmId: charm.id, trickId: t.id, probeId: toolResult.probeId || null,
                                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                            }
                            if (matched.length) trickResolutionPendingTurn = fsm.turnsUsed;
                            // Growth loop: failures NO trick covers feed the local
                            // unmatched ledger — recurring names become the next tricks.
                            if (!matchedAll.length) {
                                const names = tricksMod.extractMessageNames(raw.messages || toolResult.error);
                                if (names.length) {
                                    M.unmatchedTrickSigs = (M.unmatchedTrickSigs || 0) + 1;
                                    tricksMod.recordUnmatched(tricksState.unmatchedPath, names, raw.messages || toolResult.error);
                                }
                            }
                        }
                        // Several unsuccessful probes in a row → think for one turn
                        // (once per streak; re-armed by the next success).
                        if (streakThinkArmed && reasoningCfg.onFailureStreak > 0
                            && consecutiveFailures >= reasoningCfg.onFailureStreak) {
                            streakThinkPending = true;
                            streakThinkArmed = false;
                        }
                        // FindRoot seed roulette (run 23-30-37: ~10 turns re-seeding the
                        // same singular target across p006/p029/p036/p040/p048): on the
                        // 2nd consecutive kernel failure of FindRoot code, demand a
                        // METHOD switch, not another seed. Once per streak.
                        const failedCode = (callArgs && callArgs.code) || toolResult.lastCellCode || '';
                        if (findRootNudgeArmed && consecutiveFailures >= 2 && /\bFindRoot\b/.test(failedCode)) {
                            findRootNudgeArmed = false;
                            appendToLastToolOrUser(messages,
                                '[System: second consecutive FindRoot failure. Do NOT try another seed — ' +
                                'switch method now: clear denominators into a POLYNOMIAL system and use ' +
                                'Solve/NSolve (exhaustive, no seeds), change variables (e.g. momentum ' +
                                'parametrization u = Cot[k/2]/2), or raise WorkingPrecision. State the ' +
                                'switch in your note.]');
                        }
                        if (consecutiveFailures >= 3) {
                            bus.appendEvent('fairy.consecutive_failures', {
                                questId: quest.id, charmId: charm.id, count: consecutiveFailures,
                            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                            appendToLastToolOrUser(messages,
                                `[System: ${consecutiveFailures} consecutive probe failures. ` +
                                'Before your next probe: (1) call lookup on any unfamiliar function, ' +
                                '(2) change your approach — do not retry the same code. ' +
                                '(3) If you are debugging a HAND-ROLLED implementation of a known published ' +
                                'method (a combinatorial rule, a recursion, a special-function identity), STOP ' +
                                'debugging: the bug is probably your recollection of the method, not the code. ' +
                                'Call research_literature for the precise formulation — one literature call is ' +
                                'cheaper than N debugging probes. ' +
                                'State explicitly in the note field what you are changing and why.]',
                            );
                            consecutiveFailures = 0;  // reset so we don't spam every subsequent failure
                        }
                    }
                }

                // R1/R7: amend_probe — fix the prior probe in place. First FREE_AMENDS
                // are free; further amends of the same probe each cost one probe.
                if (call.name === 'amend_probe' && toolResult.kind !== 'nothing_to_amend' && toolResult.kind !== 'bad_args') {
                    const paid = amendsUsedForCurrentProbe >= FREE_AMENDS;
                    amendsUsedForCurrentProbe++;
                    M.amends = (M.amends || 0) + 1;
                    if (paid) { try { fsm.consumeProbe(); } catch (_) {} }
                    if (toolResult.ok !== false) {
                        lastProbeFailed = false;       // the failure is resolved
                        lastProbeKernelFailed = false;
                        findRootNudgeArmed = true;
                        consecutiveFailures = 0;
                        bus.appendEvent('fairy.amend', {
                            questId: quest.id, charmId: charm.id,
                            probeId: toolResult.probeId || lastProbeId,
                            free: !paid, amendsUsed: amendsUsedForCurrentProbe,
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                        // Re-render the corrected cell in working.wb (same probeId slot).
                        bus.appendEvent('probe.appended', {
                            questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
                            probeId: toolResult.probeId || lastProbeId,
                            code:    (callArgs && callArgs.code) || '',
                            note:    (callArgs && callArgs.note) || '',
                            value:   (toolResult.raw && toolResult.raw.value) || '',
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    } else {
                        lastProbeFailed = true;        // still broken — stay in fix mode
                        // A kernel-failed amend keeps the gate armed; a REJECTED amend
                        // (redefinition/syntax — nothing evaluated) leaves the previous
                        // state: the original ❌ cell, if any, is still there.
                        if (KERNEL_FAIL_KINDS.has(toolResult.kind)) lastProbeKernelFailed = true;
                    }
                }

                // M9: a successful record means a step was locked in — progress was made,
                // so clear all rebuild counters (the model is extending, not stuck).
                // R4: a record/note_fact clears the MATCHING pending-record entries.
                // (It used to wipe the whole backlog — one record after 10 unrecorded
                // probes silently dropped the other 9 from tracking, which is how run
                // Q32/C02 accumulated 28 unrecorded clean results and delivered at 0.45.)
                if ((call.name === 'record' || call.name === 'note_fact') && toolResult.ok !== false) {
                    for (const k of Object.keys(rebuildCounts)) delete rebuildCounts[k];
                    const clearedProbeId = (call.name === 'record')
                        ? ((callArgs && callArgs.probeId) || toolResult.probeId || null)
                        : null;
                    const clearedSyms = new Set([
                        ...(Array.isArray(toolResult.definesSymbols) ? toolResult.definesSymbols : []),
                        ...(call.name === 'note_fact' && callArgs && callArgs.key ? [String(callArgs.key)] : []),
                    ]);
                    for (let i = pendingRecords.length - 1; i >= 0; i--) {
                        const p = pendingRecords[i];
                        if ((clearedProbeId && p.probeId === clearedProbeId) || clearedSyms.has(p.symbol)) {
                            pendingRecords.splice(i, 1);
                        }
                    }
                    if (call.name === 'record')    M.records   = (M.records || 0) + 1;
                    if (call.name === 'note_fact') {
                        M.noteFacts = (M.noteFacts || 0) + 1;
                        bus.appendEvent('fact.recorded', {
                            questId: quest.id, charmId: charm.id,
                            key: String((callArgs && callArgs.key) || ''),
                            value: String((callArgs && callArgs.value) || '').slice(0, 1000),
                            confidence: (callArgs && callArgs.confidence) || null,
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    }

                    // P4: auto-checkpoint after every AUTO_CHECKPOINT_EVERY records, so a
                    // budget-overrun run still leaves committed sub-results in clean_in_progress.wb.
                    if (call.name === 'record') {
                        recordsSinceCheckpoint++;
                        if (shouldAutoCheckpoint(recordsSinceCheckpoint, AUTO_CHECKPOINT_EVERY)) {
                            recordsSinceCheckpoint = 0;
                            try {
                                const validSteps = await workDir.loadValidSteps().catch(() => []);
                                if (validSteps.length) {
                                    const inp  = await workDir.loadInputs().catch(() => []);
                                    const asm  = await workDir.loadAssumptions().catch(() => []);
                                    const title = `Auto-checkpoint (${validSteps.length} steps)`;
                                    await workDir.appendCheckpointSection({ sectionTitle: title, steps: validSteps, inputs: inp, assumptions: asm });
                                    M.checkpoints = (M.checkpoints || 0) + 1;
                                    bus.appendEvent('checkpoint.recorded', {
                                        questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
                                        sectionTitle: title, stepsIncluded: validSteps.map(s => s.id), note: 'auto', auto: true,
                                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                                }
                            } catch (_) { /* auto-checkpoint never blocks the run */ }
                        }
                    }
                }
                if (call.name === 'inspect') M.inspects = (M.inspects || 0) + 1;
                if (call.name === 'lit_read' && toolResult.ok !== false) M.litReads = (M.litReads || 0) + 1;
                if (call.name === 'note_skill_gap' && toolResult.ok !== false) {
                    M.skillGapNotes = (M.skillGapNotes || 0) + 1;
                    bus.appendEvent('skill.gap_recorded', {
                        questId: quest.id, charmId: charm.id, source: 'agent',
                        topic: (callArgs && callArgs.topic) || '',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }

                // cite_skill — the agent explicitly settled a recalled skill's disposition.
                // A step-linked 'used' citation is the authoritative "skill used" signal
                // (drives used_reproduced); 'pass_over' satisfies the gate without credit.
                if (call.name === 'cite_skill' && toolResult.ok !== false) {
                    const ref = (callArgs && callArgs.skillRef) || '';
                    // pass_over AND contradicted both settle the citation gate
                    // without crediting the skill (a refuted skill must never
                    // read as "used" in the deliverable or in SkilXiv feedback).
                    const _disp = (callArgs && callArgs.disposition) || 'used';
                    const isPassOver = _disp === 'pass_over' || _disp === 'contradicted';
                    if (ref && recallState) {
                        if (isPassOver) {
                            recallState.passedOver = recallState.passedOver || new Set();
                            recallState.passedOver.add(ref);
                        } else {
                            recallState.cited = recallState.cited || new Set();
                            recallState.cited.add(ref);
                            recallState.referenced = true;  // back-compat flag
                        }
                    }
                    bus.appendEvent('skill.cited', {
                        questId: quest.id, charmId: charm.id,
                        skillRef: ref, how: (callArgs && callArgs.how) || '',
                        disposition: _disp,
                        stepIds: (callArgs && callArgs.stepIds) || [],
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }

                // Post-dispatch: research_literature — record the brief telemetry
                if (call.name === 'research_literature' && toolResult.ok !== false) {
                    const brief = (toolResult.raw && toolResult.raw.brief) || null;
                    const diag  = (brief && brief.diagnostics) || {};
                    M.literatureQueries = (M.literatureQueries || 0) + 1;
                    // Live summary cell in working.wb so the user sees the findings.
                    if (brief) {
                        try {
                            const md = buildLiteratureBriefMarkdown(brief);
                            if (md) bus.appendEvent('literature.brief', {
                                questId: quest.id, charmId: charm.id, markdown: md,
                            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                        } catch (_) {}
                    }
                    bus.appendEvent('literature.searched', {
                        questId: quest.id, charmId: charm.id,
                        question: (callArgs && callArgs.question) || '',
                        keywords: (brief && brief.plan && brief.plan.keywords) || null,
                        searched: diag.searched || 0,     // raw hits from the backends
                        read:     diag.read || 0,         // papers actually fetched + read
                        fullText: diag.fullText || 0,     // got full text (not just abstract)
                        relevant: diag.relevant || 0,     // judged relevant after reading
                        papers:   brief ? (brief.papers || []).length : 0,
                        equations: brief ? (brief.key_equations || []).length : 0,
                        topTitle: brief && brief.papers && brief.papers[0] ? String(brief.papers[0].title || '').slice(0, 80) : null,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }

                // Post-dispatch: invalidate triggers backtrack + possible phase return
                if (call.name === 'invalidate' && toolResult.ok !== false) {
                    try { fsm.consumeBacktrack(); } catch (_) {}
                    messages.push({ role: 'tool', tool_call_id: call.id, content: toolMsgContent(toolResult) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: true,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    if (phase === 'diagnose') return { type: 'return_to_explore' };
                    continue;
                }

                // Post-dispatch: finalize triggers terminal routing
                if (call.name === 'finalize') {
                    messages.push({ role: 'tool', tool_call_id: call.id, content: toolMsgContent(toolResult) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: toolResult.ok !== false,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    if (toolResult.ok === false) continue; // bad args — steer and continue
                    const status  = toolResult.status  || callArgs.status  || 'escalate';
                    const summary = toolResult.summary || callArgs.summary || '';
                    const reason  = toolResult.reason  || callArgs.reason  || '';
                    return { type: status === 'failed' ? 'failed' : 'escalate', summary, reason };
                }

                messages.push({
                    role: 'tool', tool_call_id: call.id,
                    _turnIndex: fsm.turnsUsed,
                    content: toolMsgContent(toolResult),
                });
                await bus.appendEvent('correlated.tool', {
                    correlationId, name: call.name, ok: toolResult.ok !== false,
                    kind: toolResult.kind || null,
                    summary: toolResult.summary || null,
                    error: toolResult.error || (toolResult.ok === false && toolResult.raw && toolResult.raw.messages) || null,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }

        } else {
            // No tool calls — check for control signal
            const content = result.content || '';
            // Never push an EMPTY assistant turn (a truncated/blank reply adds
            // no information and empty assistant messages in later thinking-mode
            // requests are exactly the shape the API rejected in run 21-04-54).
            if (String(content || '').trim()) {
                messages.push({ role: 'assistant', content });
            }

            // Essay-truncation recovery (run 10-41-07): once thinking is capped
            // the model "thinks in content" — long plaintext analysis that hits
            // the output cap with NO action. Don't let it resume the essay:
            // force a decision.
            if (result.stopReason === 'length' && String(content || '').trim()) {
                M.essayTruncations = (M.essayTruncations || 0) + 1;
                consecutiveEssays++;
                // Escalate on repeat (run 15-11-39: essay→same-rejected-probe→essay
                // oscillation, 21 essays): the second consecutive essay means the
                // generic nudge failed — demand a STRUCTURAL change of direction.
                messages.push({ role: 'user', content: consecutiveEssays >= 2
                    ? '[STOP. You are looping: repeated analysis without progress. In ONE short reply: ' +
                      '(1) name the approach you are ABANDONING, (2) name the structurally different ' +
                      'approach you will try next (different method, not different constants), and ' +
                      '(3) emit its first tool call. If no different approach exists, record what IS ' +
                      'established (note_fact) and emit done_exploring with partial results — an honest ' +
                      'partial beats an infinite loop.]'
                    : '[Your reply hit the output cap mid-analysis with NO action. Do NOT continue the ' +
                      'essay — state your conclusion in ≤3 sentences, then EMIT A TOOL CALL (or control ' +
                      'signal) in this same reply. Analysis without action is wasted budget.]' });
                continue;
            }
            consecutiveEssays = 0;

            const control = tryParseControlSignal(content);
            if (control) {
                if (control.control === 'done_exploring') {
                    // One-shot finishing gates (explore only). Each fires at most once;
                    // re-emitting done_exploring always passes afterwards.
                    if (phase === 'explore') {
                        const deferrals = [];
                        // B7: cross-check gate — a finished chain must contain at least
                        // one step recorded with role:'crosscheck'.
                        if (!crosscheckNudged) {
                            let hasCrosscheck = false;
                            try {
                                const vs = await workDir.loadValidSteps();
                                // A machine-run check that PASSED (record.checks) is a
                                // kernel-adjudicated crosscheck — stronger than a
                                // self-labelled role, no extra probe needed.
                                hasCrosscheck = vs.some(s => s && (s.role === 'crosscheck'
                                    || (Array.isArray(s.checks) && s.checks.some(c => c && c.passed))));
                            } catch (_) { hasCrosscheck = true; /* fail-open: never block on an I/O error */ }
                            if (!hasCrosscheck) {
                                crosscheckNudged = true;
                                M.crosscheckGates = (M.crosscheckGates || 0) + 1;
                                bus.appendEvent('fairy.crosscheck_gate', {
                                    questId: quest.id, charmId: charm.id, turnsUsed: fsm.turnsUsed,
                                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                                deferrals.push(
                                    'No cross-check is recorded (rule 24) and no recorded step carries a passing ' +
                                    'machine check. CHEAPEST fix: one probe with `record: {stepId, role: "crosscheck", ' +
                                    'checks: [...]}` — the checks are WL expressions the harness runs now against the ' +
                                    'live kernel (trace/symmetry identity, count match, independent-method agreement: ' +
                                    'True or |residual| < tol). If an already-recorded step genuinely serves as the ' +
                                    'cross-check, re-emit done_exploring — it will be accepted.');
                            }
                        }
                        // H3 (run Q_3VRPXL): chain-completeness gate. Symbols the recorded
                        // chain USES but never RECORDS a definer for will be auto-recovered
                        // at compile (H2), but a properly-recorded step carries the agent's
                        // note and intent — nudge once, naming the defining probes.
                        if (!missingDepsNudged) {
                            try {
                                const vs = await workDir.loadValidSteps();
                                const defined = new Set();
                                for (const s of vs) for (const sym of (s.definesSymbols || [])) defined.add(sym);
                                try { for (const u of await workDir.loadUtils()) if (u && u.name) defined.add(u.name); } catch (_) {}
                                // Handoff-seeded inputs define symbols too (the record-time
                                // check counts them; this gate must agree — run Q32 flagged
                                // symbols the previous charm had seeded).
                                try {
                                    for (const inp of await workDir.loadInputs()) {
                                        for (const sym of analyzeCode((inp && inp.code) || '').definesSymbols) defined.add(sym);
                                    }
                                } catch (_) {}
                                const missing = [];
                                for (const s of vs) {
                                    for (const sym of (s.usesSymbols || [])) {
                                        // usesSymbols may predate additions to WL_BUILTINS
                                        // (steps.json is persisted) — re-filter here so a
                                        // built-in never blocks done_exploring.
                                        if (WL_BUILTINS.has(sym)) continue;
                                        if (!defined.has(sym) && !missing.includes(sym)) missing.push(sym);
                                    }
                                }
                                if (missing.length) {
                                    // Precision rule (2026-08-01 gold baseline: 8 of 9 gate
                                    // firings flagged pure noise — bound iterator variables
                                    // and built-ins the hand-list missed): only defer when we
                                    // can point at an ACTIONABLE defining probe. A "missing"
                                    // symbol no probe ever defined is either a binding-form
                                    // artifact of the static analyzer or a builtin; the real
                                    // gaps are caught by compile auto-recovery + run_clean.
                                    const recent = await workDir.loadRecentProbes(200).catch(() => []);
                                    const hints = [];
                                    for (const sym of missing.slice(0, 6)) {
                                        const definer = recent.filter(rp => rp && rp.ok && rp.code)
                                            .reverse()
                                            .find(rp => extractTargetSymbol(rp.code) === sym
                                                || new RegExp(`(?:^|\\n)\\s*${sym}\\s*(?:\\[[^\\]]*\\])?\\s*:?=`).test(rp.code));
                                        if (definer) hints.push(`\`${sym}\` (probe ${definer.probeId} defines it — \`record\` that probe)`);
                                    }
                                    if (hints.length) {
                                        missingDepsNudged = true;
                                        M.missingDepGates = (M.missingDepGates || 0) + 1;
                                        bus.appendEvent('fairy.missing_deps_gate', {
                                            questId: quest.id, charmId: charm.id, missing: missing.slice(0, 6),
                                            actionable: hints.length,
                                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                                        deferrals.push(
                                            `Your recorded chain uses symbols that NO recorded step, util, or input defines: ${hints.join(', ')}. ` +
                                            'The fresh-kernel replay would fail on them. Record the defining probes now (the harness can ' +
                                            'auto-recover them, but a recorded step carries your note and intent) — then re-emit done_exploring.');
                                    }
                                }
                            } catch (_) { /* completeness check is best-effort */ }
                        }
                        // I16: citation reconciliation — a skill was consulted (injected into
                        // context) but never cited or declined. Two consecutive runs consulted
                        // the same skill without a verdict; the usage feedback is meaningless
                        // without one.
                        if (!citationNudged && recallLive && recallLive.injected
                            && recallState && recallState.cited && recallState.cited.size === 0
                            && !(recallState.passedOver && recallState.passedOver.size > 0)) {
                            citationNudged = true;
                            M.citationGates = (M.citationGates || 0) + 1;
                            bus.appendEvent('fairy.citation_gate', {
                                questId: quest.id, charmId: charm.id,
                                skillRef: recallLive.refs[recallLive.refs.length - 1] || null,
                            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                            deferrals.push(
                                `You consulted the skill ${recallLive.refs[recallLive.refs.length - 1] || ''} this run. ` +
                                'Settle its disposition: if its METHOD or a formula genuinely shaped your derivation, call ' +
                                '`cite_skill` with the recorded stepIds that embody it; if it did NOT help, call ' +
                                "`cite_skill` with disposition: 'pass_over' and a one-line reason (zero cost, honest " +
                                'feedback). Then re-emit done_exploring.');
                        }
                        if (deferrals.length) {
                            messages.push({ role: 'user', content:
                                '[done_exploring deferred — resolve the following, then re-emit:]\n\n- ' +
                                deferrals.join('\n\n- ') });
                            continue;
                        }
                    }
                    // Dev self-postmortem: fire on the accepted done_exploring, with
                    // the full (cache-warm) explore history — right before compile.
                    if (fairySettings.selfPostmortem !== false) {
                        try {
                            await runSelfPostmortem({ bus, adapter, binding, messages, signal, spanId, quest, charm, workDir, fsm, M });
                        } catch (_) { /* best-effort — never blocks compile */ }
                    }
                    return {
                        type:         'done_exploring',
                        targetStepId: control.targetStepId,
                        includeSteps: Array.isArray(control.includeSteps) ? control.includeSteps : [],
                        excludeSteps: Array.isArray(control.excludeSteps) ? control.excludeSteps : [],
                    };
                }
                if (control.control === 'escalate') {
                    return { type: 'escalate', reason: control.reason || 'model requested escalation' };
                }
            }

            messages.push({ role: 'user', content: STEER_NO_ACTION });
        }
    }

    // Budget exhausted — the self-report is MOST valuable on struggling runs
    // (it precedes salvage-compile or the partial report either way). Skipped if
    // an earlier exhaustion already produced one (continuation loops).
    if (phase === 'explore' && fairySettings.selfPostmortem !== false && !M.selfPostmortem) {
        try {
            await runSelfPostmortem({ bus, adapter, binding, messages, signal, spanId, quest, charm, workDir, fsm, M });
        } catch (_) { /* best-effort */ }
    }
    return { type: 'exhausted' };
}

/**
 * Run the polish phase: agent must call run_clean (allClean: true) then emit
 * clean_verified. Agent may also call edit_cell, probe, chain, finalize.
 *
 * Returns one of:
 *   { type: 'clean_verified' }
 *   { type: 'reopen_chain', stepId, reason }   — B4: a recorded step is wrong (once per run)
 *   { type: 'failed', summary, reason }
 *   { type: 'escalate', reason }
 *   { type: 'exhausted' }
 */
async function runPolishTurns({
    messages, fsm, adapter, binding, bus, signal, spanId, quest, charm, workDir, allowReopen,
}) {
    // I5: charm carries validationChecks (run by run_clean); polishState carries the
    // validation fail-streak across run_clean calls within this polish phase.
    const fairyCtx = { workDir, shim: wolframShim, signal, charm, polishState: {} };
    let cleanVerified = false; // set to true when run_clean returned allClean: true
    // I6: redundant-run_clean guard + identical-failure detection (run Q_2N8616:
    // a second run_clean after a pass wasted 32s; two runs failed IDENTICALLY
    // because a disk-only edit never reached the open document).
    let lastRunCleanPassed  = false;
    let editsSinceRunClean  = 0;
    let lastFailureSig      = null;

    const STEER_POLISH =
        'No tool call or control signal found. ' +
        'Call `run_clean` to verify clean.wb. After run_clean returns allClean: true, ' +
        'emit `{ "control": "clean_verified" }` as plain JSON text.';

    // Selective thinking in polish (2026-08-01, user-reported: with reasoning
    // fully off the deliverable was assembled mechanically — "it just copies
    // all cells as is" — and the success claim was rubber-stamped): think on
    // polish ENTRY (curation: what belongs in clean.wb, what needs edit_cell)
    // and on the turn AFTER every run_clean result (the delivered/partial
    // decision must be deliberate, pass or fail).
    const polishReasoningCfg = settings.fairyReasoning();
    // I5: trivial runs skip the polish ENTRY think (a failing run_clean still
    // re-arms thinking below — failure always deserves deliberation).
    let polishThinkNext = polishReasoningCfg.onPhaseEntry && charm._complexity !== 'trivial';

    while (fsm.canPolishTurn()) {
        fsm.incrementPolishTurn();
        const polishThinkTurn = polishReasoningCfg.cadence !== 0 && polishThinkNext;
        polishThinkNext = false;
        const result = await callOnceWithRetry({
            bus, adapter, binding, messages, tools: POLISH_FAIRY_TOOL_SPECS,
            signal, spanId, prefixSha256: null, quest, charm,
            turnIndex: fsm.turnsUsed,
            thinkTurn: polishThinkTurn, thinkEffort: polishReasoningCfg.effort,
            thinkBoost: 6000,   // polish decides, it doesn't derive — no 24k runway
            fastCap: 4000,
            thinkContext: polishThinkTurn ? buildThinkContext(messages, '') : null,
        });

        if (signal && signal.aborted) throw new Error('aborted');

        const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
        // (post-run_clean thinking is decided from the RESULT below — a
        // first-attempt clean pass skips the extra think turn, P5)

        if (calls.length > 0) {
            messages.push({
                role: 'assistant',
                content: result.content || '',
                // No reasoning_content in history: V4's thinking-mode round-trip
                // demand applies only when the request TAIL is an assistant/tool
                // run — callOnce appends a reflection user message to every
                // thinking request, which lifts the requirement entirely
                // (empirically mapped 2026-08-02). History stays lean.
                tool_calls: calls.map(c => ({
                    id: c.id, type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
                })),
            });

            for (const call of calls) {
                const callArgs = call.arguments || {};
                const correlationId = 'cor_' + crypto.randomBytes(6).toString('hex');

                await bus.appendEvent('tool.call', {
                    correlationId, name: call.name, args: truncateArgsForUi(callArgs),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

                // POLISH GUARD: only run_clean / edit_cell / probe / chain / finalize are valid
                // here. Reject anything else (models sometimes call invalidate, define_util, …
                // which are NOT offered) BEFORE dispatch — invalidate in particular pruned a
                // step AND DELETED the verified clean.wb (the deliverable), failing the run.
                if (!POLISH_ALLOWED.has(call.name)) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:   `'${call.name}' is not available in the polish phase — it would not fix the clean notebook.`,
                            suggestedAction: 'Use `edit_cell` to fix the offending cell, then `run_clean` to re-verify. Do not invalidate or rebuild — the recorded chain is final; only the clean.wb cells may be edited.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'tool_not_in_polish_set',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    continue;
                }

                // run_clean budget guard
                if (call.name === 'run_clean' && !fsm.canPolishRunClean()) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:   'run_clean budget exhausted for this polish phase',
                            suggestedAction: 'Call finalize(failed) if the notebook cannot be made clean.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'run_clean_budget_exhausted',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    continue;
                }

                // I6: a second run_clean after a PASS with nothing edited since is pure
                // waste (30+ seconds of kernel restart + full replay). Reject it.
                if (call.name === 'run_clean' && lastRunCleanPassed && editsSinceRunClean === 0) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:   'clean.wb already verified (allClean: true) and no cell was edited since. Re-running changes nothing.',
                            suggestedAction: 'Emit { "control": "clean_verified" } as plain JSON now.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'run_clean_redundant',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    continue;
                }

                // probe budget guard (uses remaining diagnose budget)
                if (call.name === 'probe' && !fsm.canProbe()) {
                    messages.push({ role: 'tool', tool_call_id: call.id,
                        content: JSON.stringify({
                            rejected: true,
                            reason:   'probe budget exhausted — no probes remaining',
                            suggestedAction: 'Edit the cell directly with edit_cell based on your understanding of the error.',
                        }) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: false, error: 'probe_budget_exhausted',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    continue;
                }

                const toolResult = await dispatchFairyTool({ name: call.name, args: callArgs }, fairyCtx);

                // Track run_clean budget and whether we got allClean: true
                if (call.name === 'run_clean') {
                    try { fsm.consumePolishRunClean(); } catch (_) {}
                    editsSinceRunClean = 0;
                    if (toolResult.ok) {
                        let payload;
                        try { payload = JSON.parse(toolResult.modelPayload || '{}'); } catch (_) { payload = {}; }
                        if (payload.allClean === true) cleanVerified = true;
                        lastRunCleanPassed = payload.allClean === true;
                        // P5 (2026-08-02): the post-run_clean think turn is spent only
                        // when there is something to deliberate — a FIRST-attempt clean
                        // pass with no disputed checks goes straight to clean_verified.
                        const firstTryClean = payload.allClean === true
                            && fsm.polishRunCleansUsed === 1
                            && !(payload.disputedPlannerChecks && payload.disputedPlannerChecks.length);
                        polishThinkNext = !firstTryClean;
                        // I6: identical-failure detection — the same cells failing with the
                        // same errors twice in a row means the edit did not address the root
                        // cause (or never reached the executed document). Force a diagnosis
                        // step before the next blind edit.
                        if (payload.allClean !== true) {
                            const sig = (payload.failures || [])
                                .map(f => `${f.cellIndex}:${String(f.error || f.messages || '').slice(0, 60)}`)
                                .join('|');
                            if (sig && sig === lastFailureSig) {
                                appendToLastToolOrUser(messages,
                                    '[System: the SAME cells failed with the SAME errors as the previous run_clean — ' +
                                    'your edit did not address the root cause. Before the next edit_cell, use `probe` ' +
                                    'to evaluate the failing expression in the live kernel and understand WHY it fails. ' +
                                    'If a recorded step is mathematically wrong, emit reopen_chain instead of editing around it.]');
                            }
                            lastFailureSig = sig || null;
                            // P9 (2026-08-02): auto-attach the first failing cell's FULL
                            // source so the model needn't spend a chain/inspect turn
                            // fetching what the harness already knows.
                            try {
                                const first = (payload.failures || [])[0];
                                if (first && Number.isInteger(first.cellIndex)) {
                                    const nb = JSON.parse(await require('fs/promises').readFile(workDir.cleanNb, 'utf8'));
                                    const codeCells = (nb.cells || []).filter(c => c && c.kind === 2);
                                    const cell = codeCells[first.cellIndex] || (nb.cells || [])[first.cellIndex];
                                    if (cell && cell.value) {
                                        appendToLastToolOrUser(messages,
                                            `[Failing cell ${first.cellIndex} source (full):\n` +
                                            String(cell.value).slice(0, 2000) + '\n]');
                                    }
                                }
                            } catch (_) { /* best-effort context attach */ }
                        } else {
                            lastFailureSig = null;
                        }
                    }
                }

                // I6: count edits between run_cleans (feeds the redundancy guard).
                if (call.name === 'edit_cell' && toolResult.ok !== false) {
                    editsSinceRunClean++;
                }

                // probe budget tracking in polish
                if (call.name === 'probe' && toolResult.ok !== false) {
                    try { fsm.consumeProbe(); } catch (_) {}
                    // Signal UI to append live cell to working.wb
                    bus.appendEvent('probe.appended', {
                        questId: quest.id, charmId: charm.id,
                        charmDir: workDir.dir,
                        probeId:  toolResult.probeId || '',
                        code:     (callArgs && callArgs.code) || '',
                        note:     (callArgs && callArgs.note) || '[polish probe]',
                        value:    (toolResult.raw && toolResult.raw.value) || '',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }

                // finalize in polish
                if (call.name === 'finalize') {
                    messages.push({ role: 'tool', tool_call_id: call.id, content: toolMsgContent(toolResult) });
                    await bus.appendEvent('correlated.tool', {
                        correlationId, name: call.name, ok: toolResult.ok !== false,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    if (toolResult.ok === false) continue;
                    const status  = toolResult.status  || callArgs.status  || 'escalate';
                    const summary = toolResult.summary || callArgs.summary || '';
                    const reason  = toolResult.reason  || callArgs.reason  || '';
                    return { type: status === 'failed' ? 'failed' : 'escalate', summary, reason };
                }

                messages.push({
                    role: 'tool', tool_call_id: call.id,
                    _turnIndex: fsm.turnsUsed,
                    content: toolMsgContent(toolResult),
                });
                await bus.appendEvent('correlated.tool', {
                    correlationId, name: call.name, ok: toolResult.ok !== false,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }

        } else {
            const content = result.content || '';
            // Never push an EMPTY assistant turn (a truncated/blank reply adds
            // no information and empty assistant messages in later thinking-mode
            // requests are exactly the shape the API rejected in run 21-04-54).
            if (String(content || '').trim()) {
                messages.push({ role: 'assistant', content });
            }

            const control = tryParseControlSignal(content);
            if (control && control.control === 'clean_verified') {
                if (!cleanVerified) {
                    // Enforce: must have a passing run_clean before accepting clean_verified
                    messages.push({ role: 'user', content:
                        '**clean_verified rejected**: You must call `run_clean` first and it must return `allClean: true`. ' +
                        'The harness has not seen a successful run_clean yet. Call `run_clean` now.' });
                    continue;
                }
                return {
                    type: 'clean_verified',
                    // Stage 2: planner checks that were downgraded after repeated
                    // failure cap the terminal status at partial_delivered.
                    validationDowngraded: !!(fairyCtx.polishState && fairyCtx.polishState.validationDowngraded),
                };
            }

            // B4: the model diagnosed a wrong RECORDED step (not a cell-text issue).
            // Route back to Explore via the outer loop — once per run.
            if (control && control.control === 'reopen_chain') {
                if (!allowReopen) {
                    messages.push({ role: 'user', content:
                        '**reopen_chain rejected**: the one-per-run chain reopen has already been used. ' +
                        'Fix the remaining issues with `edit_cell` + `run_clean`, or call finalize(failed).' });
                    continue;
                }
                return {
                    type:   'reopen_chain',
                    stepId: String(control.stepId || ''),
                    reason: String(control.reason || ''),
                };
            }

            if (control && (control.control === 'escalate' || control.control === 'done_exploring')) {
                return { type: 'escalate', reason: 'model escalated during polish phase' };
            }

            messages.push({ role: 'user', content: STEER_POLISH });
        }
    }

    return { type: 'exhausted' };
}

/**
 * Run the partial-report phase: bonus turns for the agent to write clean_partial.wb.
 *
 * The agent is given only `chain` and `write_partial_report` tools.
 * Returns:
 *   { type: 'partial_delivered', partialNbPath }
 *   { type: 'exhausted' }
 */
async function runPartialReportTurns({
    messages, fsm, adapter, binding, bus, signal, spanId, quest, charm, workDir,
}) {
    const fairyCtx = { workDir, shim: wolframShim, signal };
    let reportWritten = false;
    let partialNbPath = null;

    const STEER_PARTIAL =
        'No tool call found. ' +
        'Call `chain` to review what was recorded, then call `write_partial_report` to write the partial results notebook.';

    // Honest partial reporting benefits from one deliberate turn (what worked,
    // what failed, how to re-scope) — think on entry only.
    const partialReasoningCfg = settings.fairyReasoning();
    let partialFirstTurn = true;

    while (fsm.canPartialReportTurn()) {
        fsm.incrementPartialReportTurn();
        const partialThink = partialReasoningCfg.cadence !== 0
            && partialReasoningCfg.onPhaseEntry && partialFirstTurn
            && charm._complexity !== 'trivial';
        partialFirstTurn = false;
        const result = await callOnceWithRetry({
            bus, adapter, binding, messages, tools: PARTIAL_REPORT_TOOL_SPECS,
            signal, spanId, prefixSha256: null, quest, charm,
            turnIndex: fsm.turnsUsed,
            thinkTurn: partialThink, thinkEffort: partialReasoningCfg.effort,
        });

        if (signal && signal.aborted) throw new Error('aborted');

        const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];

        if (calls.length > 0) {
            messages.push({
                role: 'assistant',
                content: result.content || '',
                // No reasoning_content in history: V4's thinking-mode round-trip
                // demand applies only when the request TAIL is an assistant/tool
                // run — callOnce appends a reflection user message to every
                // thinking request, which lifts the requirement entirely
                // (empirically mapped 2026-08-02). History stays lean.
                tool_calls: calls.map(c => ({
                    id: c.id, type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
                })),
            });

            for (const call of calls) {
                const callArgs = call.arguments || {};
                const correlationId = 'cor_' + crypto.randomBytes(6).toString('hex');

                await bus.appendEvent('tool.call', {
                    correlationId, name: call.name, args: truncateArgsForUi(callArgs),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

                const toolResult = await dispatchFairyTool({ name: call.name, args: callArgs }, fairyCtx);

                if (call.name === 'write_partial_report' && toolResult.ok !== false) {
                    let payload;
                    try { payload = JSON.parse(toolResult.modelPayload || '{}'); } catch (_) { payload = {}; }
                    if (payload.path) {
                        reportWritten = true;
                        partialNbPath = payload.path;
                    }
                }

                messages.push({
                    role: 'tool', tool_call_id: call.id,
                    content: JSON.stringify(toolResult),
                });
                await bus.appendEvent('correlated.tool', {
                    correlationId, name: call.name, ok: toolResult.ok !== false,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

                if (reportWritten) return { type: 'partial_delivered', partialNbPath };
            }

        } else {
            if (String(result.content || '').trim()) {
                messages.push({ role: 'assistant', content: result.content || '' });
            }
            messages.push({ role: 'user', content: STEER_PARTIAL });
        }
    }

    // Budget exhausted without the agent writing the report — write a best-effort one anyway
    try {
        const steps       = await workDir.loadAllSteps().catch(() => []);
        const inputs      = await workDir.loadInputs().catch(() => []);
        const assumptions = await workDir.loadAssumptions().catch(() => []);
        partialNbPath = await workDir.writePartialNotebook({
            steps, inputs, assumptions,
            summary: 'Partial report was not written by the agent before partial_report phase budget was exhausted.',
            failedAttempts: [],
            openQuestions: [],
            recommendations: 'Review the recorded steps in this run and manually assess what remains.',
        });
    } catch (_) {}

    return { type: 'exhausted', partialNbPath };
}

/**
 * B2: build executable evidence items from recorded steps so the Skeptic can
 * re-verify the chain. `tool` MUST be 'wolfram_eval' — the Skeptic's Layer-1
 * loop skips any other tool name. Output prefers the probe's agentValue
 * (kernel InputForm — the same rendering the Skeptic's re-eval produces) over
 * the human/LaTeX value so compareOutputs can match exactly or by substring.
 *
 * @param {object[]} steps                             valid steps, recorded order
 * @param {(probeId: string) => Promise<object|null>} getProbe
 * @param {number} [maxItems]
 * @returns {Promise<object[]>}
 */
async function buildEvidenceFromSteps(steps, getProbe, maxItems = 12) {
    const out = [];
    for (const s of (steps || []).slice(-maxItems)) {
        if (!s || !s.probeId || !s.code) continue;
        const snap = s.evidenceSnapshot;
        if (snap && snap.ok === true && snap.code === s.code && snap.output) {
            out.push({
                tool:       'wolfram_eval',
                stepId:     s.id,
                expression: snap.code,
                output:     String(snap.output).slice(0, 2000),
                ok:         true,
                evidenceSha256: snap.sha256 || null,
            });
            continue;
        }
        let probe = null;
        try { probe = await getProbe(s.probeId); } catch (_) { probe = null; }
        if (!probe || !probe.ok) continue;
        const value = (typeof probe.agentValue === 'string' && probe.agentValue.length)
            ? probe.agentValue
            : (probe.value || '');
        if (!value) continue;
        out.push({
            tool:       'wolfram_eval',
            stepId:     s.id,
            expression: s.code,
            output:     String(value).slice(0, 2000),
            ok:         true,
            evidenceSha256: null, // legacy step without immutable snapshot
        });
    }
    return out;
}

/**
 * Build and persist a Scroll from the terminal FSM result.
 * Returns { scroll, fileRef }.
 */
async function buildAndPersistScroll({ terminalResult, workDir, quest, charm, bus, fsm, spanId, recallResult }) {
    const status = (terminalResult && terminalResult.status) || 'escalate';

    let steps = [];
    try { steps = await workDir.loadValidSteps(); } catch (_) {}
    let establishedFacts = [];
    try { establishedFacts = await workDir.loadFacts(); } catch (_) {}

    // Record of what executed. The clean.wb replay (run_clean) is the
    // verification; this evidence list is the trace behind it, not a re-checked
    // claim (there is no longer a Skeptic/Wards layer to re-verify against).
    let evidence = [];
    try { evidence = await buildEvidenceFromSteps(steps, (id) => workDir.getProbe(id)); } catch (_) { evidence = []; }

    // Confidence is derived purely from the terminal status set by the Fairy's
    // own clean.wb run: `delivered` means the fresh-kernel replay was clean.
    // There is no separate self-verify re-eval (its encoding-only false
    // mismatches were the Q25/Q32 confidence-collapse root cause).
    const confidence = status === 'delivered'         ? 0.9
        : status === 'partial_delivered'              ? 0.6
        : status === 'failed'                         ? 0.1
        :                                               0.05;

    const statusNote =
        status === 'delivered'         ? 'Clean-run verification passed (clean.wb re-ran cleanly on a fresh kernel).'
        : status === 'partial_delivered' ? `Partial results written to clean_partial.wb: ${((terminalResult && terminalResult.reason) || '').slice(0, 200)}`
        : status === 'failed'          ? `Failed: ${((terminalResult && terminalResult.summary) || '').slice(0, 200)}`
        :                                `Escalated: ${((terminalResult && terminalResult.reason)  || '').slice(0, 200)}`;

    const factPunchline = establishedFacts.length
        ? `${establishedFacts[0].key}: ${establishedFacts[0].value}` : '';
    const summary = [
        `Charm ${charm.id} — ${statusNote}`,
        steps.length > 0 ? `${steps.length} recorded step(s).` : 'No steps recorded.',
        factPunchline ? `Punchline: ${factPunchline}` : '',
    ].filter(Boolean).join(' ').slice(0, 1000);

    // Mark cut-off code explicitly: downstream LLM narrators judged "the construction
    // appears incomplete (truncated bond sums)" from a display ellipsis (run Q25).
    const findings = establishedFacts.length > 0
        ? establishedFacts.map(f => `${f.key}: ${f.value}${f.confidence ? ` [${f.confidence}]` : ''}`).slice(0, 32)
        : steps.length > 0
        ? steps.map(s => {
            const code = String(s.code || '');
            const snippet = code.length > 200 ? code.slice(0, 200) + ' …[snippet truncated for display — full code in the notebook]' : code;
            return `**Step ${s.id}** (${(s.definesSymbols || []).join(', ') || 'no new symbols'}): \`${snippet}\``;
          }).slice(0, 32)
        : [`Run terminated with status '${status}'.`];

    const openQuestions = status !== 'delivered'
        ? [((terminalResult && (terminalResult.reason || terminalResult.summary)) || `Status: ${status}`).slice(0, 500)]
        : [];

    const scroll = {
        id:            'S01',
        questId:       quest.id,
        charmId:       charm.id,
        summary,
        findings,
        openQuestions,
        confidence,
        selfChecks:    [],
        evidence,
        createdAt:     new Date().toISOString(),
        fairyArtifact: {
            status,
            charmDir:        workDir.dir,
            // B4: a polish-failed partial_delivered run still carries its compiled
            // clean.wb — include the path whenever the terminal result has one.
            cleanNbPath:     (terminalResult && terminalResult.cleanNbPath)   || null,
            partialNbPath:   (terminalResult && terminalResult.partialNbPath) || null,
            candidateNbPath: (terminalResult && terminalResult.candidateNbPath) || null,
            phaseHistory:    fsm.phaseHistory,
            budget:          fsm.getBudgetStatus(),
            steps:           steps.map(s => ({ id: s.id, probeId: s.probeId, definesSymbols: s.definesSymbols || [] })),
            recallMode:         (recallResult && recallResult.mode)      || 'none',
            skillConsultedRef:  (recallResult && recallResult.skillRef)  || null,
        },
    };

    const scrollId = await scrollsFs.nextScrollId(quest).catch(() => 'S01');
    scroll.id = scrollId;

    const fileRef = await scrollsFs.writeScroll(quest, scroll)
        .catch(e => ({ path: null, sha256: null, error: e.message }));

    try {
        const conclusionPath = path.join(workDir.dir, 'CONCLUSION.md');
        const lines = [
            `# ${charm.title || quest.title || 'Fairy result'}`, '',
            `**Status:** ${status}`, '', '## Punchline', '',
            establishedFacts.length
                ? establishedFacts.map(f => `- **${f.key}:** ${f.value}${f.confidence ? ` _(${f.confidence})_` : ''}`).join('\n')
                : statusNote,
            '', '## Verification', '',
            status === 'delivered'
                ? '- The recorded notebook chain re-executed cleanly.'
                : '- This is a partial or failed result and is not promoted as verified.',
            `- Recorded steps: ${steps.length}.`, `- Evidence items: ${evidence.length}.`,
            '', '## Open questions', '',
            openQuestions.length ? openQuestions.map(q => `- ${q}`).join('\n') : '- None recorded.',
            '', '## Provenance', '', `- Quest: \`${quest.id}\``, `- Charm: \`${charm.id}\``,
            `- Scroll: \`${scroll.id}\``,
            `- Notebook: \`${(terminalResult && (terminalResult.cleanNbPath || terminalResult.partialNbPath)) || 'not produced'}\``, '',
        ];
        await fsp.writeFile(conclusionPath, lines.join('\n'), 'utf8');
        scroll.fairyArtifact.conclusionPath = conclusionPath;
        await scrollsFs.writeScroll(quest, scroll).catch(() => {});
        await bus.appendEvent('conclusion.written', {
            questId: quest.id, charmId: charm.id, path: conclusionPath,
            punchline: factPunchline.slice(0, 500),
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
    } catch (_) {}

    await bus.appendEvent('scroll.submitted', {
        scrollId:    scroll.id,
        questId:     quest.id,
        charmId:     charm.id,
        status,
        confidence,
        fileRef,
        phaseHistory: fsm.phaseHistory,
        budget:      fsm.getBudgetStatus(),
        evidenceCount: evidence.length,
        cleanNbPath:   (terminalResult && terminalResult.cleanNbPath)   || null,
        partialNbPath: (terminalResult && terminalResult.partialNbPath) || null,
        conclusionPath: scroll.fairyArtifact.conclusionPath || null,
        steps: steps.map(s => ({
            id:             s.id,
            probeId:        s.probeId,
            code:           (s.code || '').slice(0, 300),
            definesSymbols: s.definesSymbols || [],
            usesSymbols:    (s.usesSymbols || []).slice(0, 8),
            dependsOn:      s.dependsOn || [],
            note:           s.note || '',
        })),
    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

    return { scroll, fileRef };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * @param {{
 *   quest:  object,
 *   charm:  object,
 *   bus:    import('../telemetry/bus').TelemetryBus,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<{ scroll: object, fileRef: {path:string, sha256:string} }>}
 */
async function runFairy(args) {
    if (!args || !args.quest || !args.charm) throw new Error('runFairy: quest and charm are required');
    const { quest, charm, bus, signal, writeNotebook, getWorkingNbDoc } = args;
    // Optional UI hook: when the run would stop (budget exhausted or the model escalates),
    // ask the user whether to continue with a fresh budget instead of ending. Returns
    // a Promise<boolean>. Provided by index.js (which has VS Code dialog access).
    const askContinue = typeof args.askContinue === 'function' ? args.askContinue : null;
    let continuations = 0;
    const MAX_CONTINUATIONS = 3;
    const CONTINUE_GRANT = { probes: 15, turns: 25, backtracks: 3 };

    // Role binding is resolved ONCE per run. `bindingRole` lets a caller run this
    // charm on a different role — the Director's escalation path retries a
    // twice-failed stage on the stronger judgment model (plan §Stage 4). Falls
    // back silently to 'fairy' if the requested role is unconfigured, so a
    // half-configured setup degrades instead of failing the run.
    let binding = roles.resolveRole('fairy');
    if (args.bindingRole && args.bindingRole !== 'fairy') {
        const alt = roles.resolveRole(args.bindingRole);
        if (alt && alt.configured) {
            binding = alt;
            bus.appendEvent('fairy.binding_override', {
                questId: quest.id, charmId: charm.id,
                role: args.bindingRole, provider: alt.provider, model: alt.model,
            }, { questId: quest.id, charmId: charm.id }).catch(() => {});
        }
    }
    if (!binding.configured) {
        const err = new Error('Fairy role is not configured (provider + model + API key required).');
        err.kind = 'not_configured';
        throw err;
    }
    const summaryBinding = roles.resolveRole('fairy_summariser');
    const adapter = getAdapter(binding.provider);
    const spanId  = makeSpanId();

    // Literature sub-agent wiring (research_literature tool). The paper tools are
    // pure functions over INSPIRE/arXiv; the LLM is a fast/cheap completion used to
    // rank papers and extract equations. Both are optional — if the literature role
    // is unconfigured the sub-agent falls back to top-k papers with no extraction.
    const paperSearch = require('../../tools/paperSearch');
    const paperTools = {
        // NB: forward the 3rd `opts` arg ({sort}) — the literature agent passes
        // sort:'mostcited' (#3); dropping it silently disables impact ranking.
        searchPapers: (params, max, opts) =>
            paperSearch.searchPapers({ ...params, query: (params && (params.q || params.query)) || '' }, max, opts),
        searchArxiv:     (params, max, opts) => paperSearch.searchArxiv(params, max, opts),
        searchInspire:   (params, max, opts) => paperSearch.searchInspire(params, max, opts),
        // R6: Semantic Scholar relevance search — rescues prose/method queries that
        // arXiv's exact AND-grammar returns nothing for; supplies citation counts.
        searchSemanticScholar: (params, max) => paperSearch.searchSemanticScholar(params, max),
        fetchPaperHtml:  paperSearch.fetchPaperHtml,
        extractSections: paperSearch.extractSections,
        getInspireBibtex: paperSearch.getInspireBibtex,
        // Citation-graph clients (Phase 3): enable backward (#4) + forward (#18) snowball.
        getInspireReferences: paperSearch.getInspireReferences,
        getCitationContexts:  paperSearch.getCitationContexts,
    };
    const litBinding = roles.resolveRole('literature');
    const litAdapter = litBinding.configured ? getAdapter(litBinding.provider) : null;
    const literatureLlm = (litAdapter && litBinding.configured)
        ? async (prompt) => {
            try {
                const res = await litAdapter.chatComplete({
                    messages: [
                        { role: 'system', content: 'You are a precise literature-extraction assistant for physics/math papers. Answer tersely and exactly as instructed.' },
                        { role: 'user',   content: String(prompt) },
                    ],
                    model:       litBinding.model,
                    temperature: 0.1,
                    // R8: 800 truncated DeepSeek's plan/reformulate JSON mid-reply
                    maxTokens:   litBinding.maxTokens || 2000,
                    signal,
                }, { pricing: litBinding.pricing });
                bus.appendEvent('llm.call', {
                    role: 'literature', model: litBinding.model,
                    usage: res.usage || {}, costUSD: res.costUSD || null,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                return res.content || '';
            } catch (_) { return ''; }
        }
        : null;

    let charmDir;
    try { charmDir = resolveCharmDir(quest, charm); }
    catch (e) { throw Object.assign(e, { kind: 'no_workspace' }); }

    const workDir = await createWorkDir(charmDir);

    // M6: register the post-restart util seeder so that if the kernel restarts
    // mid-run, all registered helpers are re-evaluated once and remain callable
    // by name. Also re-applies the non-critical-warning suppression (Off[...]) so it
    // survives a restart. Cleared in the finally block at the end of the run.
    wolframShim.setPostRestartSeeder(async () => {
        const utils = await workDir.getUtilsCode().catch(() => '');
        return wolframShim.buildSuppressionCode() + '\n' + utils;
    });

    const inputs      = Array.isArray(charm.inputs)      ? charm.inputs      : [];
    const assumptions = Array.isArray(charm.assumptions) ? charm.assumptions : [];

    // Full reset before each run: clear probe results, steps, assumptions, and
    // the working notebook so reruns always start at p001 with a clean scratchpad.
    const fsp = require('fs/promises');
    await Promise.all([
        // Reset working.wb (with a subtle distinct tint marking it as the agent's scratchpad)
        fsp.writeFile(workDir.workingNb, JSON.stringify({ cells: [], metadata: {} }, null, 2), 'utf8').catch(() => {}),
        // Reset steps and assumptions (but keep inputs — set by the caller)
        fsp.writeFile(workDir.stepsFile,  JSON.stringify([], null, 2), 'utf8').catch(() => {}),
        fsp.writeFile(workDir.assumFile,  JSON.stringify([], null, 2), 'utf8').catch(() => {}),
        // Reset per-run memory: utils, plan, facts, cited skills
        fsp.writeFile(workDir.utilsFile,  JSON.stringify([], null, 2), 'utf8').catch(() => {}),
        fsp.writeFile(workDir.factsFile,  JSON.stringify([], null, 2), 'utf8').catch(() => {}),
        fsp.writeFile(workDir.citedSkillsFile, JSON.stringify([], null, 2), 'utf8').catch(() => {}),
        fsp.writeFile(workDir.literatureFile, JSON.stringify([], null, 2), 'utf8').catch(() => {}),
        fsp.rm(workDir.planFile, { force: true }).catch(() => {}),
        // Clear all probe result files so nextProbeCounter() starts at 1
        fsp.readdir(workDir._dir + '/results').then(files =>
            Promise.all(files.filter(f => f.endsWith('.json')).map(f =>
                fsp.unlink(workDir._dir + '/results/' + f).catch(() => {})))
        ).catch(() => {}),
    ]);

    await bus.appendEvent('fairy.started', {
        questId: quest.id, charmId: charm.id,
        provider: binding.provider, model: binding.model,
        charmDir,
        workingNbPath: workDir.workingNb,
        build: BUILD_INFO,   // I18: which code actually ran (catches stale deploys)
    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

    // ── RECALL phase — R5: kick off concurrently with kernel setup. I12: NON-
    // BLOCKING — 17.8s and 54s recalls were observed; a hard timeout drops skills,
    // blocking stalls the run. Instead: wait briefly (fast path → skill lands in the
    // first, cacheable message); otherwise start exploring and inject the skill
    // MID-RUN when it arrives. ────────────────────────────────────────────────
    const recallCfg = settings.recall();
    const skilxivClient = recallCfg.enabled
        ? await require('../fairy/skilxivCredentials').createClient({ baseUrl: recallCfg.skilxivBaseUrl })
        : null;
    let recallPromise = Promise.resolve({ mode: 'none', recallLog: { error: 'recall disabled' } });
    // P4 (2026-08-02): recall fast-path skip. Short, self-contained computation
    // briefs (a known integral, a closed form, one diagonalisation) can never
    // productively match a skill, yet recall added 2 LLM calls + a recall_slow
    // delay to EVERY run. Length is measured on the core brief only (an
    // appended OUTPUT CONTRACT block doesn't make a task less trivial).
    const _coreBrief = String(charm.task || charm.goal || charm.title || '').split('OUTPUT CONTRACT')[0].trim();
    const _shortBrief = _coreBrief.length > 0 && _coreBrief.length < 300;
    const _runFullRecall = () => {
        const taskText = String(charm.task || charm.goal || charm.title || '');
        return runRecall(taskText, {
            client:    skilxivClient,
            signal,
            timeoutMs: 60000,                    // I12: generous — no longer blocks run start
            llm:       literatureLlm || null,    // I11: triage across all candidates
        }).catch(e => ({
            mode: 'none',
            recallLog: { error: (e && e.message) || String(e) },
        }));
    };
    if (recallCfg.enabled && !charm.confidential && _shortBrief) {
        // P4 revised (run ejiy7g: a 257-char TS09 brief was "trivial"-skipped
        // while the registry's #1 hit was the exact skill for it — the flywheel
        // broke at the gate): brief LENGTH is a bad triviality proxy. Short
        // briefs now get a raw-brief SkilXiv SEARCH probe first (one HTTP call,
        // zero LLM); only a weak top score skips the LLM recall stages.
        recallPromise = (async () => {
            let top = 0, topRef = null;
            try {
                const hits = skilxivClient ? await skilxivClient.search(_coreBrief, { limit: 3, signal }) : [];
                const list = Array.isArray(hits) ? hits : (hits && (hits.results || hits.hits)) || [];
                if (list[0]) { top = Number(list[0].score ?? list[0].similarity) || 0; topRef = list[0].ref || list[0].id || null; }
            } catch (_) { /* search down → behave like the old fast path */ }
            if (top >= 0.4) {
                bus.appendEvent('recall.short_brief_promoted', {
                    questId: quest.id, charmId: charm.id, briefChars: _coreBrief.length, topScore: top, topRef,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                return _runFullRecall();
            }
            bus.appendEvent('recall.completed', {
                questId: quest.id, charmId: charm.id, mode: 'skipped_trivial',
                briefChars: _coreBrief.length, topScore: top,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            return { mode: 'none', recallLog: { skipped: 'short_brief_weak_match', briefChars: _coreBrief.length, topScore: top } };
        })();
    } else if (recallCfg.enabled && !charm.confidential) {
        recallPromise = _runFullRecall();
    }

    const { kernelFresh, inputsLoaded } = await setupWorkingKernel({ workDir, inputs, assumptions, bus, signal, spanId, quest, charm });

    // ── O6: cross-charm handoff — charm N's verified utils are re-evaluated into
    // the fresh kernel and its established facts seeded into the ledger, so charm
    // N+1 EXTENDS prior work instead of re-deriving it from a prose summary. ────
    const handoff = args.handoff || null;
    const handoffSeeded = { utils: [], facts: [] };
    if (handoff) {
        for (const u of (handoff.utils || []).slice(0, 12)) {
            if (!u || !u.name || !u.code) continue;
            try {
                const r = await wolframShim.evalOnce({ expression: u.code, signal });
                if (r && r.ok) {
                    await workDir.addUtil({ name: u.name, code: u.code, note: u.note || 'from previous sub-task' });
                    handoffSeeded.utils.push(u.name);
                }
            } catch (_) { /* a failing util is simply not carried over */ }
        }
        for (const f of (handoff.facts || []).slice(0, 20)) {
            if (!f || !f.key) continue;
            try {
                await workDir.addFact({
                    key: f.key, value: f.value, confidence: f.confidence,
                    provenance: `handoff:${f.provenance || 'previous sub-task'}`,
                });
                handoffSeeded.facts.push(f.key);
            } catch (_) {}
        }
        if (handoffSeeded.utils.length || handoffSeeded.facts.length) {
            bus.appendEvent('fairy.handoff_seeded', {
                questId: quest.id, charmId: charm.id,
                utils: handoffSeeded.utils, facts: handoffSeeded.facts,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        }
    }

    // I12: fast path (5s) — a fast backend behaves exactly as before.
    const FAST_RECALL_MS = 5000;
    let recallResult = await Promise.race([
        recallPromise,
        new Promise(resolve => setTimeout(() => resolve(null), FAST_RECALL_MS)),
    ]);
    // recallLive: mutable view shared with the model loop. `refs` feeds cite_skill
    // validation (live array — late arrivals push into it); `block` is the reference
    // material; `injected` records whether the model ever actually SAW the skill
    // (usage feedback and the skills-used block key off this, not off mode alone).
    // Stage 3 progressive disclosure: `sections` holds every recalled skill's
    // parsed H2 sections so `read_skill_section` can serve the part that the
    // prompt-injection cap truncated (long skills used to lose their tail).
    const recallLive = { refs: [], block: null, gaps: [], injected: false, sections: new Map() };
    const _applyRecall = (res) => {
        if (!res) return;
        recallResult = res;
        // S1: capabilities with NO fitting registry skill — surfaced to the model
        // ("derive it cleanly") and auto-filed as skill requests on delivery. Gaps
        // exist even when a skill WAS found (a marginal hit must not mask them).
        recallLive.gaps = Array.isArray(res.gaps) ? res.gaps.slice(0, 4) : [];
        if (res.mode !== 'none' || res.skillRef) {
            bus.appendEvent('recall.completed', {
                questId:    quest.id,
                charmId:    charm.id,
                mode:       res.mode,
                skillRef:   res.skillRef || null,
                skillCount: Array.isArray(res.skills) ? res.skills.length : (res.skillRef ? 1 : 0),
                gaps:       recallLive.gaps,
                recallLog:  res.recallLog,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        }
        if (res.mode === 'consult' && res.skillRef) {
            // S1: up to 2 picked skills, each with its graded-fit annotation so the
            // model knows what the skill covers and what it must derive itself.
            const skillList = (Array.isArray(res.skills) && res.skills.length) ? res.skills : [res];
            const blocks = [];
            for (const sk of skillList) {
                if (!sk || !sk.skillRef) continue;
                recallLive.refs.push(sk.skillRef);
                if (sk.sections) recallLive.sections.set(sk.skillRef, sk.sections);
                let block = buildRecallContextBlock({ ...sk, mode: 'consult' });
                if (sk.fit) {
                    block += `\nFIT ASSESSMENT for ${sk.skillRef}: ${sk.fit.toUpperCase()}` +
                        (sk.capability ? ` (serves: ${sk.capability})` : '') +
                        (sk.covers ? `. Covers: ${sk.covers}` : '') +
                        (sk.lacks ? `. LACKS: ${sk.lacks} — adapt the method or derive that part yourself.` : '') + '\n';
                }
                blocks.push(block);
            }
            recallLive.block = blocks.join('\n');
        }
    };
    if (recallResult) {
        _applyRecall(recallResult);
    } else {
        recallResult = { mode: 'none', recallLog: { pending: true } };
        recallPromise.then(res => _applyRecall(res)).catch(() => {});
        bus.appendEvent('omen', {
            kind: 'recall_slow',
            message: `SkilXiv recall still pending after ${FAST_RECALL_MS}ms — starting the run; the skill will be injected when it arrives.`,
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
    }
    const recallBlock = recallLive.block;   // fast path only — goes into the first message
    if (recallBlock) recallLive.injected = true;
    // Stage 3: cross-run lessons excerpt (grimoire lessons section). Read here so
    // it lands in the cacheable first user message; failures are silent.
    let lessonsBlock = '';
    try {
        lessonsBlock = await require('../memory/lessons').lessonsExcerpt(
            require('../memory/grimoire').grimoireFilePath(), { limit: 8, maxChars: 1200 });
        if (lessonsBlock) {
            bus.appendEvent('fairy.lessons_injected', {
                questId: quest.id, charmId: charm.id, chars: lessonsBlock.length,
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        }
    } catch (_) { lessonsBlock = ''; }
    if (recallLive.gaps && recallLive.gaps.length) recallLive.gapsShown = true;   // in the first message via skillGaps
    // Skill use is declared by the agent (cite_skill), not inferred. recallState.cited
    // accumulates the skillRefs the agent explicitly cited as used.
    const recallState = { referenced: false, cited: new Set() };

    // I13/I20: skill-gap recorder — shared by the note_skill_gap tool and the
    // end-of-run harness trigger. Local ledger always; registry request best-effort.
    const recordSkillGapFn = async ({ topic, why, source }) => skillGaps.recordSkillGap({
        topic, why, source: source || 'agent',
        task:    String(charm.task || charm.goal || charm.title || ''),
        questId: quest.id, charmId: charm.id,
        client:  skilxivClient,
    });

    // Budgets come from the LIVE `budgets.fairyFsm` setting (Stage 1, 2026-08:
    // FairyFSM previously always ran on hard-coded defaults).
    const fsm = new FairyFSM(settings.fairyFsmBudget());
    // Instrument transitionTo to fire UI phase-change events (fire-and-forget).
    const _fsmTransitionOrig = fsm.transitionTo.bind(fsm);
    fsm.transitionTo = (newPhase) => {
        _fsmTransitionOrig(newPhase);
        bus.appendEvent('fairy.phase', {
            questId: quest.id, charmId: charm.id,
            phase: newPhase, phaseHistory: fsm.phaseHistory,
            budget: fsm.getBudgetStatus(),
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
    };
    fsm.transitionTo('explore');

    // Tricks v1.0 Phase 1 (local pack; design: SkilXiv Docs/20-tricks-v1.0.md).
    // Tier A: top gotchas in the STABLE system prefix (cache-cheap prevention).
    // Tier B: signature-matched injection on probe failure (wired in the loop).
    let tricksState = { list: [], shown: Object.create(null), unmatchedPath: null };
    try {
        const oberonDir = require('../memory/project').oberonDir();
        const localPath = oberonDir ? require('path').join(oberonDir, 'tricks', 'tricks.local.json') : null;
        tricksState.unmatchedPath = oberonDir ? require('path').join(oberonDir, 'tricks', 'unmatched.jsonl') : null;
        tricksState.list = tricksMod.loadTricks(localPath);
    } catch (_) { try { tricksState.list = tricksMod.loadTricks(null); } catch (_) {} }
    const tricksPrefix = tricksMod.renderPrefixPack(tricksState.list, { maxChars: 6000 });

    const messages = [
        { role: 'system', content: FAIRY_SYSTEM_PROMPT + tricksPrefix },
        { role: 'user',   content: buildExploreUserMessage({
            taskDescription: String(charm.task || charm.goal || charm.title || 'Perform the computation described in this Charm.'),
            inputs,
            assumptions,
            // B2: show the planner's validation checks up front so the agent names
            // its symbols to match — the Skeptic executes these after delivery.
            validationChecks: Array.isArray(charm.validationChecks) ? charm.validationChecks : [],
            // O6: names of utils/facts seeded from the previous sub-task.
            handoff: (handoffSeeded.utils.length || handoffSeeded.facts.length) ? handoffSeeded : null,
            // S1: capabilities the registry has NO skill for (fast-path recall only;
            // late-resolving recalls inject gaps mid-run instead).
            skillGaps: recallLive.gaps,
            budget: {
                exploreProbesRemaining: fsm.exploreProbesRemaining,
                backtracksRemaining:    fsm.backtracksRemaining,
                turnsRemaining:         fsm.turnsRemaining,
            },
            charmId:       charm.id,
            kernelFresh,
            inputsLoaded,
            recallBlock:   recallBlock || null,
            lessonsBlock:  lessonsBlock || null,   // Stage 3: cross-run lessons
        }) },
    ];

    let targetStepId        = null;
    let currentIncludeSteps = [];
    let currentExcludeSteps = [];
    let terminalResult      = null;
    let lastCompileResult   = null;
    let salvageCompileUsed  = false;   // one budget-exhausted → compile salvage per run
    // B4: polish salvage state — one structural chain reopen per run, and the
    // compiled clean.wb + failure context carried into a polish-failure partial report.
    let polishReopensUsed   = 0;
    let pendingCleanNbPath  = null;
    let polishFailureContext = null;

    // Create steer queue for this run. Index.js will expose setSteerQueue so the UI
    // can push text; messages are drained one-per-turn in runModelTurns.
    const steerQueue = new SteerQueue();
    if (args.onSteerQueueReady) args.onSteerQueueReady(steerQueue);

    // R10: run-efficiency metrics accumulator (mutated in runModelTurns).
    const metrics = {
        probesOk: 0, probesFailed: 0, records: 0, noteFacts: 0,
        amends: 0, repeatAbandon: 0, inspects: 0,
    };

    // Ask the user whether to continue instead of stopping (budget exhausted / escalate).
    // On "yes", extend the budget and resume Explore from the current state. Returns true
    // if the run should continue. No-op when no askContinue hook is wired.
    async function _maybeContinue(kind, reason) {
        if (!askContinue || continuations >= MAX_CONTINUATIONS || fsm.isTerminal) return false;
        let want = false;
        try {
            want = await askContinue({
                kind, reason,
                records:    metrics.records || 0,
                noteFacts:  metrics.noteFacts || 0,
                probesUsed: fsm.probesUsed,
                turnsUsed:  fsm.turnsUsed,
                continuation: continuations + 1,
            });
        } catch (_) { want = false; }
        if (!want) return false;
        continuations++;
        fsm.grantMoreBudget(CONTINUE_GRANT);
        // O11: also raise the run-level cap, or the loop would re-trigger immediately.
        metrics.runCapBonus = (metrics.runCapBonus || 0) + CONTINUE_GRANT.turns;
        messages.push({ role: 'user', content:
            `[The user chose to CONTINUE. Fresh budget granted: +${CONTINUE_GRANT.probes} probes, +${CONTINUE_GRANT.turns} turns. ` +
            `You have ${metrics.records || 0} recorded step(s) and ${metrics.noteFacts || 0} fact(s) so far. ` +
            'Consolidate what you have and finish the remaining sub-problems toward a complete, recordable result.]' });
        await bus.appendEvent('fairy.continued', {
            questId: quest.id, charmId: charm.id, kind, continuation: continuations, grant: CONTINUE_GRANT,
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        return true;
    }

    // Polish-phase variant: clean.wb still has warnings/errors. Offer more polish budget
    // so the agent can FINISH cleaning it (the deliverable must verify clean).
    async function _maybeContinuePolish(reason) {
        if (!askContinue || continuations >= MAX_CONTINUATIONS || fsm.isTerminal) return false;
        let want = false;
        try {
            want = await askContinue({
                kind: 'polish', reason,
                records: metrics.records || 0, noteFacts: metrics.noteFacts || 0,
                probesUsed: fsm.probesUsed, turnsUsed: fsm.turnsUsed, continuation: continuations + 1,
            });
        } catch (_) { want = false; }
        if (!want) return false;
        continuations++;
        fsm.grantMoreBudget({ polishTurns: 6, polishRunCleans: 3, turns: 8 });
        messages.push({ role: 'user', content:
            '[The user chose to CONTINUE polishing. More polish budget granted. The clean notebook MUST verify ' +
            'fully clean before finishing: call run_clean, fix EVERY remaining warning/error with edit_cell, and ' +
            'repeat until run_clean returns allClean: true. Do not stop while any warning remains.]' });
        await bus.appendEvent('fairy.continued', {
            questId: quest.id, charmId: charm.id, kind: 'polish', continuation: continuations,
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        return true;
    }

    // ── Outer FSM loop ────────────────────────────────────────────────────────
    while (!fsm.isTerminal) {
        const phase = fsm.phase;

        if (phase === 'explore' || phase === 'diagnose') {
            let loopResult;
            try {
                loopResult = await runModelTurns({
                    phase, messages, fsm, adapter, binding, summaryBinding, bus, signal, spanId, quest, charm, workDir, getWorkingNbDoc,
                    steerQueue: phase === 'explore' ? steerQueue : null,
                    recallLive, recallState,
                    metrics, paperTools, literatureLlm, recordSkillGapFn,
                    tricksState,
                });
            } catch (e) {
                if (signal && signal.aborted) {
                    terminalResult = { status: 'escalate', reason: 'aborted by user' };
                    fsm.transitionTo('escalate');
                    break;
                }
                // O2: a non-abort error (e.g. a provider 400) must NOT discard the run.
                // Salvage: emit an omen, mark escalate, and break to the end-of-run blocks
                // so recorded steps, usage feedback, and metrics are still persisted.
                bus.appendEvent('fairy.error', {
                    questId: quest.id, charmId: charm.id, phase,
                    message: (e && e.message) || String(e),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                terminalResult = { status: 'escalate', reason: `run error in ${phase}: ${(e && e.message) || String(e)}` };
                fsm.transitionTo('escalate');
                break;
            }

            if (loopResult.type === 'done_exploring') {
                targetStepId        = loopResult.targetStepId;
                currentIncludeSteps = loopResult.includeSteps || [];
                currentExcludeSteps = loopResult.excludeSteps || [];
                fsm.transitionTo('compile');

            } else if (loopResult.type === 'escalate') {
                // Ask the user before giving up — in isolated/quick-compute mode an
                // escalate usually means "I'm stuck", and the user may want to weigh in.
                if (await _maybeContinue('escalate', loopResult.reason)) continue;
                terminalResult = { status: 'escalate', reason: loopResult.reason };
                fsm.transitionTo('escalate');

            } else if (loopResult.type === 'failed') {
                terminalResult = { status: 'failed', summary: loopResult.summary, reason: loopResult.reason };
                fsm.transitionTo('failed');

            } else if (loopResult.type === 'return_to_explore') {
                fsm.transitionTo('explore');
                messages.push({ role: 'user', content: 'Returning to Explore after invalidation. Resume building the chain from your remaining valid steps.' });

            } else {
                // Salvage compile (run 16-30-00): the explore turn budget ran out at the
                // exact moment the chain was complete (5 valid steps incl. a crosscheck)
                // — and the continuation dialog then sat unanswered for 5.5 h before
                // falling to partial_report. If the recorded chain already looks
                // deliverable, skip the dialog and spend the compile/polish budgets
                // (they are separate FSM pools) on shipping it properly.
                if (!salvageCompileUsed) {
                    const validSteps = await workDir.loadValidSteps().catch(() => []);
                    const hasCrosscheck = validSteps.some(s => s.role === 'crosscheck');
                    if (validSteps.length >= 1 && hasCrosscheck) {
                        salvageCompileUsed = true;
                        const target = [...validSteps].reverse().find(s => s.role !== 'crosscheck') || validSteps[validSteps.length - 1];
                        targetStepId        = target.id;
                        currentIncludeSteps = [];
                        currentExcludeSteps = [];
                        bus.appendEvent('omen', {
                            kind: 'salvage_compile',
                            message: `Explore budget exhausted but the recorded chain is complete (${validSteps.length} valid steps incl. crosscheck) — proceeding to compile/polish instead of a partial report.`,
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                        fsm.transitionTo('compile');
                        continue;
                    }
                }
                // Budget exhausted — offer to continue with a fresh budget before falling
                // back to a partial report.
                if (await _maybeContinue('budget', 'ran out of probe/turn budget')) continue;
                fsm.transitionTo('partial_report');
            }

        } else if (phase === 'compile') {
            if (!targetStepId) {
                terminalResult = { status: 'escalate', reason: 'compile phase reached without a targetStepId' };
                fsm.transitionTo('escalate');
                continue;
            }

            // Skills-used + citation block for the clean notebook (and working.wb).
            // Stage-2 evidence linking: a skill is shown as USED only if the agent cited
            // it with disposition 'used' AND at least one of its cited stepIds SURVIVES
            // as a valid step entering this compile (all valid steps are compiled, so
            // valid ≙ in-closure). Pass-overs and citations whose evidence was later
            // invalidated appear as consulted, never used — and consulted-only skills
            // no longer enter the deliverable's skills block at all.
            let skillsBlock = '';
            if (recallResult && recallResult.skillRef && recallLive.injected) {
                const ref = recallResult.skillRef;
                const cited = await workDir.loadCitedSkills().catch(() => []);
                const citation = cited.find(c => c.skillRef === ref && c.disposition !== 'pass_over' && c.disposition !== 'contradicted');
                let usedNow = false;
                if (citation) {
                    const legacyNoSteps = !Array.isArray(citation.stepIds);   // pre-Stage-2 citations had no stepIds
                    if (legacyNoSteps) usedNow = true;
                    else {
                        const validIds = new Set((await workDir.loadValidSteps().catch(() => [])).map(s => s.id));
                        usedNow = citation.stepIds.some(id => validIds.has(id));
                    }
                }
                if (usedNow) {
                    let runReport = '';
                    try {
                        const facts = await workDir.loadFacts().catch(() => []);
                        const topFact = facts.find(f => f.confidence === 'high') || facts[0];
                        runReport = [
                            citation.how ? `Used: ${citation.how}` : '',
                            Array.isArray(citation.stepIds) && citation.stepIds.length ? `Evidence: step(s) ${citation.stepIds.join(', ')}.` : '',
                            topFact ? `Key result: ${topFact.key} = ${String(topFact.value).slice(0, 120)}` : '',
                        ].filter(Boolean).join(' ');
                    } catch (_) {}
                    skillsBlock = buildSkillsUsedMarkdown({
                        baseUrl: recallCfg.skilxivBaseUrl,
                        runReport,
                        skills: [{ ref, used: true,
                            conclusion: citation.how || undefined,
                            outcome: 'used_reproduced' }],
                    });
                }
            }
            // Append a "Literature consulted" block (independent of recalled skills) — the
            // papers surfaced by the research_literature sub-agent are cited at run end.
            try {
                const briefs = await workDir.loadLiteratureBriefs().catch(() => []);
                const litBlock = buildLiteratureCitations(briefs);
                if (litBlock) {
                    skillsBlock = skillsBlock ? `${skillsBlock}\n\n${litBlock}` : litBlock;
                    const papersCited = new Set();
                    for (const b of briefs) for (const p of (b.papers || [])) papersCited.add(p.ref || p.title);
                    bus.appendEvent('literature.cited', {
                        questId: quest.id, charmId: charm.id,
                        papers: papersCited.size, briefs: briefs.length,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }
            } catch (_) {}

            // Surface the same block in the live working notebook (inserted once).
            if (skillsBlock) {
                bus.appendEvent('skills.used', {
                    questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
                    skillRef: recallResult.skillRef || null, markdown: skillsBlock,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
            }

            let compileResult;
            try {
                compileResult = await compile(workDir, targetStepId, {
                    includeSteps:  currentIncludeSteps,
                    excludeSteps:  currentExcludeSteps,
                    taskTitle:     charm.task || charm.goal || charm.title,
                    writeNotebook,
                    skillsBlock,
                });
            } catch (e) {
                await bus.appendEvent('omen', {
                    kind: 'compile_error', message: e.message,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                compileResult = {
                    ok: false, phase: 'diagnose', closureSteps: [], cleanNbPath: null,
                    diagnostics: [{ type: 'exception', details: e.message }], targetStepMissing: false,
                };
            }
            lastCompileResult = compileResult;

            if (compileResult.ok) {
                fsm.transitionTo('polish');
            } else {
                const diagDetails = (compileResult.diagnostics || [])
                    .map(d => d.details || JSON.stringify(d)).join('\n');
                messages.push({ role: 'user', content: buildDiagnoseUserMessage({
                    classification:   'cell_errored',
                    firstFailureCell: null,
                    freshOutput:      diagDetails.slice(0, 400),
                    recordedOutput:   null,
                    messages:         (compileResult.diagnostics || []).map(d => d.details || '').slice(0, 3),
                    details:          `Compilation failed: ${diagDetails.slice(0, 400)}`,
                    budget: {
                        diagnoseProbesRemaining: fsm.diagnoseProbesRemaining,
                        diagnoseTurnsRemaining:  fsm.diagnose_turns_remaining,
                    },
                    targetStepId: targetStepId,
                }) });
                fsm.transitionTo('diagnose');
            }

        } else if (phase === 'polish') {
            const cleanNbPath = lastCompileResult && lastCompileResult.cleanNbPath;

            // Inject the polish entry message (replaces the old subprocess verify)
            messages.push({ role: 'user', content: buildPolishEntryMessage({
                cleanNbPath:          cleanNbPath || workDir.cleanNb,
                runCleansRemaining:   fsm.polishRunCleansRemaining,
                polishTurnsRemaining: fsm.polishTurnsRemaining,
            }) });

            let polishResult;
            try {
                polishResult = await runPolishTurns({
                    messages, fsm, adapter, binding, bus, signal, spanId, quest, charm, workDir,
                    allowReopen: polishReopensUsed < 1,
                });
            } catch (e) {
                if (signal && signal.aborted) {
                    terminalResult = { status: 'escalate', reason: 'aborted by user' };
                    fsm.transitionTo('escalate');
                    break;
                }
                // O2: salvage — escalate honestly. A clean.wb may be compiled but
                // polish (fresh-kernel verification) did not complete, so do NOT claim
                // delivery; record the path so the user can inspect it.
                bus.appendEvent('fairy.error', {
                    questId: quest.id, charmId: charm.id, phase: 'polish',
                    message: (e && e.message) || String(e),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                terminalResult = { status: 'escalate', cleanNbPath: cleanNbPath || null,
                    reason: `polish error (clean.wb compiled but not verified): ${(e && e.message) || String(e)}` };
                fsm.transitionTo('escalate');
                break;
            }

            if (polishResult.type === 'clean_verified') {
                if (polishResult.validationDowngraded) {
                    // Verifier-gated status: replay is clean, but adjudicable
                    // planner checks kept failing and were downgraded — the
                    // kernel disputes the claim, so 'delivered' is off the table.
                    terminalResult = {
                        status: 'partial_delivered', cleanNbPath,
                        reason: 'clean replay verified, but planner validation checks remained failing (downgraded) — capped at partial delivery',
                    };
                    fsm.transitionTo('partial_delivered');
                    bus.appendEvent('omen', {
                        kind: 'validation_downgrade_partial',
                        message: 'clean_verified accepted with downgraded validation checks — terminal status capped at partial_delivered',
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                } else {
                    terminalResult = { status: 'delivered', cleanNbPath };
                    fsm.transitionTo('delivered');
                }

            } else if (polishResult.type === 'reopen_chain') {
                // B4: the model diagnosed a wrong RECORDED step during polish. Allow ONE
                // structural reopen: invalidate the step (and dependents), return to
                // Explore, rebuild, recompile. Does not consume a backtrack.
                const stepId = polishResult.stepId;
                let pruned = null;
                if (stepId) {
                    try { pruned = await workDir.markStale(stepId); } catch (_) { pruned = null; }
                }
                if (!pruned) {
                    messages.push({ role: 'user', content:
                        `[reopen_chain: step '${stepId || '?'}' was not found among valid steps — nothing was invalidated. ` +
                        'Staying in polish: fix the notebook with edit_cell + run_clean, or name a valid stepId.]' });
                    continue;  // re-enter polish (reopen not consumed)
                }
                polishReopensUsed++;
                bus.appendEvent('fairy.chain_reopened', {
                    questId: quest.id, charmId: charm.id, stepId,
                    prunedStepIds: pruned.prunedStepIds || [],
                    reason: polishResult.reason || '',
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                metrics.chainReopens = (metrics.chainReopens || 0) + 1;
                messages.push({ role: 'user', content:
                    `[Chain reopened from polish: step '${stepId}'` +
                    ((pruned.prunedStepIds || []).length > 1 ? ` (with dependents: ${pruned.prunedStepIds.join(', ')})` : '') +
                    ` was invalidated because: ${polishResult.reason || 'unspecified'}. You are back in Explore. ` +
                    `Probes remaining: ${Math.max(0, fsm.exploreProbesRemaining)}. ` +
                    'Re-probe the corrected computation, record it (keep your crosscheck step), then emit done_exploring again.]' });
                fsm.transitionTo('explore');

            } else if (polishResult.type === 'failed') {
                // The clean notebook still has unresolved warnings/errors. Offer to keep
                // fixing (more polish budget) before giving up — the deliverable must be clean.
                if (await _maybeContinuePolish(polishResult.reason || 'clean.wb still has unresolved warnings')) continue;
                // B4: a compiled clean.wb exists — deliver it as a PARTIAL result with an
                // honest failure report instead of discarding the run as bare 'failed'.
                pendingCleanNbPath   = cleanNbPath || workDir.cleanNb;
                polishFailureContext = `Polish could not fully verify clean.wb: ${polishResult.reason || polishResult.summary || 'unresolved warnings/errors'}.`;
                fsm.transitionTo('partial_report');

            } else if (polishResult.type === 'escalate') {
                terminalResult = { status: 'escalate', reason: polishResult.reason, cleanNbPath };
                fsm.transitionTo('escalate');

            } else {
                // exhausted — offer to extend polish so the agent can finish cleaning up.
                if (await _maybeContinuePolish('ran out of polish budget before clean.wb verified')) continue;
                pendingCleanNbPath   = cleanNbPath || workDir.cleanNb;
                polishFailureContext = 'Polish budget was exhausted before clean.wb verified cleanly.';
                fsm.transitionTo('partial_report');
            }

        } else if (phase === 'partial_report') {
            // Bonus turns to write clean_partial.wb after budget exhaustion — or after
            // a polish failure (B4: polishFailureContext explains which; the compiled
            // clean.wb is then attached to the partial result).
            const stepsRecorded = (await workDir.loadAllSteps().catch(() => [])).filter(s => s.status === 'valid').length;
            messages.push({ role: 'user', content: buildPartialReportUserMessage({
                stepsRecorded,
                probesUsed:                  fsm.probesUsed,
                partialReportTurnsRemaining: fsm.partialReportTurnsRemaining,
                contextNote:                 polishFailureContext || undefined,
            }) });

            let partialResult;
            try {
                partialResult = await runPartialReportTurns({
                    messages, fsm, adapter, binding, bus, signal, spanId, quest, charm, workDir,
                });
            } catch (e) {
                if (signal && signal.aborted) {
                    terminalResult = { status: 'escalate', reason: 'aborted by user' };
                    fsm.transitionTo('escalate');
                    break;
                }
                // O2: salvage — recorded steps are already on disk; escalate gracefully.
                bus.appendEvent('fairy.error', {
                    questId: quest.id, charmId: charm.id, phase: 'partial_report',
                    message: (e && e.message) || String(e),
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                terminalResult = { status: 'escalate', reason: `partial_report error: ${(e && e.message) || String(e)}` };
                fsm.transitionTo('escalate');
                break;
            }

            const partialNbPath = partialResult && partialResult.partialNbPath;
            terminalResult = {
                status:        'partial_delivered',
                partialNbPath: partialNbPath || workDir.partialNb,
                // B4: carry the compiled-but-unverified clean.wb when polish failed.
                cleanNbPath:   pendingCleanNbPath || null,
                reason:        polishFailureContext
                    ? `${polishFailureContext} Partial results written to clean_partial.wb; the unverified clean.wb is attached.`
                    : 'probe budget exhausted; partial results written to clean_partial.wb',
            };
            fsm.transitionTo('partial_delivered');
        }
    }

    // ── Verification note ─────────────────────────────────────────────────────
    // The Fairy's own run_clean already restarted a fresh kernel and re-ran the
    // whole clean.wb through the notebook controller; `terminalResult.status ===
    // 'delivered'` means that replay was clean (allClean). That IS the
    // verification — there is deliberately no separate evidence re-eval here (the
    // old I17 verifyEvidenceQuick pass demoted confidence on encoding-only diffs
    // and caused the Q25/Q32 false-partial cascades). Confidence is derived from
    // the terminal status in buildAndPersistScroll.

    // ── End-of-run: persist scroll, raise candidate, report usage + metrics ──
    // O2/O3/O5: usage feedback, run metrics, and seeder cleanup run in a `finally`
    // so they survive even if scroll-building or the contribute step throws.
    let scroll = null, fileRef = null;
    try {
        ({ scroll, fileRef } = await buildAndPersistScroll({ terminalResult, workDir, quest, charm, bus, fsm, spanId, recallResult }));

        // ── CONTRIBUTE — Stage 2: raise a LOCAL candidate, never auto-submit ─────
        // On a delivered, non-confidential run with reusable content, write a private
        // candidate to the review inbox (the human approves later; nothing auto-submits).
        if ((terminalResult && terminalResult.status === 'delivered')
            && settings.contribution().mode !== 'off') {
            try {
                const [defsLedger, factsLedger, facts] = await Promise.all([
                    workDir.buildDefinitionsLedger({ maxChars: 6000 }).catch(() => ''),
                    workDir.buildFactsLedger({ maxChars: 2000 }).catch(() => ''),
                    workDir.loadFacts().catch(() => []),
                ]);
                const taskText = String(charm.task || charm.goal || charm.title || '');
                const title    = String(charm.title || charm.goal || taskText).slice(0, 120);
                // F6: only set a lineage parent when a recalled skill was ACTUALLY cited
                // as used. Otherwise this is NEW work → fresh skill, no false derived_from.
                const citedRecalled = !!(recallState && recallState.cited
                    && recallResult.skillRef && recallState.cited.has(recallResult.skillRef));
                const derivedFrom = citedRecalled ? recallResult.skillRef : null;
                const cand = await contributionInbox.writeCandidate({
                    charmId: charm.id, questId: quest.id, title, task: taskText,
                    status: 'delivered', confidential: !!charm.confidential,
                    inputs, outputs: Array.isArray(charm.outputs) ? charm.outputs : [],
                    definitionsLedger: defsLedger, factsLedger, factsCount: facts.length,
                    cleanNbPath: (terminalResult && terminalResult.cleanNbPath) || workDir.cleanNb,
                    derivedFrom,
                    generatedWith: `wolfbook-fairy/${binding.model || 'unknown'}`,
                });
                if (cand && cand.eligible) {
                    metrics.candidateRaised = true;
                    await bus.appendEvent('contribution.candidate', {
                        questId: quest.id, charmId: charm.id, candidateId: cand.id, dir: cand.dir,
                        derivedFrom, isNewSkill: !derivedFrom,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

                    // I15: novelty gate — only author a skill draft when the delivered
                    // result actually adds something. Reproducing a cited skill, or a
                    // near-duplicate of an existing registry entry, is not new work.
                    let novelty = 'novel';
                    if (citedRecalled) {
                        novelty = `reproduction of ${recallResult.skillRef}`;
                    } else if (skilxivClient) {
                        try {
                            const sr  = await skilxivClient.search(taskText.slice(0, 300), { limit: 3, minTier: 0 });
                            const t0r = (sr.results || [])[0];
                            const sc  = t0r && (typeof t0r.score === 'number' ? t0r.score : t0r.similarity);
                            if (typeof sc === 'number' && sc >= 0.75) {
                                novelty = `near-duplicate of @${t0r.namespace}/${t0r.name} (score ${sc.toFixed(2)})`;
                            }
                        } catch (_) { /* registry unreachable → treat as novel; human reviews anyway */ }
                    }

                    // I14: author a human-reviewable SKILL.draft.md (method stated
                    // generally) from the verified chain — one cheap LLM call.
                    let draftPath = null;
                    if (novelty === 'novel' && summaryBinding.configured) {
                        try {
                            const reply = await callSummariser(adapter, summaryBinding,
                                buildSkillAuthorPrompt({ task: taskText, definitionsLedger: defsLedger, factsLedger }),
                                bus, spanId, quest, charm);
                            const authored = parseSkillAuthorReply(reply);
                            if (authored) {
                                const md = composeSkillDraftMd({
                                    authored, task: taskText,
                                    definitionsLedger: defsLedger, model: binding.model,
                                });
                                draftPath = path.join(cand.dir, 'SKILL.draft.md');
                                await fsp.writeFile(draftPath, md, 'utf8');
                                metrics.skillDraftAuthored = true;
                            }
                        } catch (_) { /* authoring is best-effort — the raw candidate remains */ }
                    }
                    try {
                        await fsp.writeFile(path.join(cand.dir, 'novelty.json'),
                            JSON.stringify({ novelty, draftPath, at: new Date().toISOString() }, null, 2), 'utf8');
                    } catch (_) {}
                    bus.appendEvent('contribution.draft', {
                        questId: quest.id, charmId: charm.id, candidateId: cand.id,
                        novelty, draftAuthored: !!draftPath,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                } else if (cand) {
                    await bus.appendEvent('contribution.skipped', {
                        questId: quest.id, charmId: charm.id, reasons: cand.reasons,
                    }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                }
            } catch (_) { /* fail-open: candidate creation never blocks the run */ }
        }
    } finally {
        // I12: give a still-pending recall 2 more seconds to settle so the final
        // recallResult (usage feedback + metrics) reflects what actually happened.
        try {
            const finalRes = await Promise.race([
                recallPromise, new Promise(r => setTimeout(() => r(null), 2000)),
            ]);
            if (finalRes && !(finalRes.recallLog && finalRes.recallLog.pending)) recallResult = finalRes;
        } catch (_) {}

        // ── O3 + F1/F2/F5: SkilXiv usage feedback. The recalled skill is credited as
        // USED only when the agent EXPLICITLY cited it (cite_skill) — never inferred from
        // tokens. used_reproduced requires (cited AND delivered); otherwise the skill was
        // merely consulted. I12: a skill the model never SAW (late arrival, never
        // injected) is not "consulted" — skip reporting entirely.
        try {
            const skillRef = recallResult.skillRef;
            if (recallResult.mode === 'consult' && skillRef && !charm.confidential && recallLive.injected) {
                const status   = terminalResult && terminalResult.status;
                // Stage-2 evidence linking: "cited" for SkilXiv feedback means a 'used'
                // citation whose step evidence SURVIVED (pass_over and orphaned
                // citations report as consulted — honest ranking signal).
                let cited = false;
                try {
                    const allCited  = await workDir.loadCitedSkills().catch(() => []);
                    const citation  = allCited.find(c => c.skillRef === skillRef && c.disposition !== 'pass_over' && c.disposition !== 'contradicted');
                    if (citation) {
                        if (!Array.isArray(citation.stepIds)) cited = true;   // legacy citation
                        else {
                            const validIds = new Set((await workDir.loadValidSteps().catch(() => [])).map(s => s.id));
                            cited = citation.stepIds.some(id => validIds.has(id));
                        }
                    }
                } catch (_) {
                    cited = !!(recallState && recallState.cited && recallState.cited.has(skillRef));
                }
                // Valid SkilXiv outcomes: consulted | used_reproduced | diverged.
                const outcome  = (cited && status === 'delivered') ? 'used_reproduced'
                    : (cited && status && status !== 'delivered') ? 'diverged' : 'consulted';
                // A specific reason is proposed only when it can be inferred without
                // uploading task content. Detailed notes remain local unless separately approved.
                const reasonCode = outcome === 'diverged' ? 'other' : null;
                const envClass = `WL-unknown-${process.platform}-${process.arch}`;
                const eventId  = sha256(charm.id + '|' + skillRef + '|' + (status || '') + '|' + cited);
                if (cited) {
                    const receipt = outcome === 'used_reproduced'
                        ? await require('../memory/verificationReceipt').writeVerificationReceipt({
                            skillRef, contentHash: recallResult.contentHash, environment: envClass,
                            outcome: 'verified-in-delivered-run',
                            evidence: { event_id: eventId, quest_id: quest.id, charm_id: charm.id, terminal_status: status || null },
                        }).catch(() => null)
                        : null;
                    require('../memory/skillLockfile').pinSkill({
                        ref: skillRef, contentHash: recallResult.contentHash,
                        lifecycle: outcome === 'used_reproduced' ? 'verified-in-delivered-run' : 'cited-in-diverged-run',
                        compatibility: 'observed-compatible', environment: envClass,
                        evidence: { event_id: eventId, quest_id: quest.id, charm_id: charm.id, terminal_status: status || null,
                            receipt_id: receipt && receipt.ok ? receipt.id : null },
                    }).catch(() => {});
                }

                // Prefer the agent's own "how it helped" note; else a short content-light line.
                const contribCfg = settings.contribution();
                const sharePublicly = !!contribCfg.shareUsagePublicly;
                let agentReport = null;
                try {
                    const citedList = await workDir.loadCitedSkills().catch(() => []);
                    const citation  = citedList.find(c => c.skillRef === skillRef);
                    if (citation && citation.how) {
                        agentReport = `Used: ${citation.how}`.slice(0, 600);
                    } else {
                        const taskShort = String(charm.task || charm.goal || charm.title || '').replace(/\s+/g, ' ').slice(0, 180);
                        agentReport = ['Consulted this skill (not cited as used).', taskShort ? `Task: ${taskShort}` : '']
                            .filter(Boolean).join(' ').slice(0, 600);
                    }
                } catch (_) {}

                // The report is the USER'S OWN data — always store it locally (regardless
                // of sharePublicly) so they can read their own run reports. Only the
                // *remote* submission is gated by the privacy opt-in.
                const usageEvent = { skill: skillRef, outcome, cited, reasonCode, event_id: eventId,
                    environment_class: envClass, sharePublicly, report: agentReport,
                    questId: quest.id, charmId: charm.id, timestamp: new Date().toISOString() };
                const fsp = require('fs/promises');
                const usageLogPath = path.join(charmDir, '..', '..', '..', '..', 'usage_log.jsonl');
                fsp.appendFile(usageLogPath, JSON.stringify(usageEvent) + '\n', 'utf8').catch(() => {});
                // Also persist alongside the run for easy discovery.
                fsp.writeFile(path.join(workDir.dir, 'skill_usage.json'),
                    JSON.stringify(usageEvent, null, 2), 'utf8').catch(() => {});

                await bus.appendEvent('skill.usage_reported', {
                    questId: quest.id, charmId: charm.id, skillRef, outcome, cited, sharePublicly,
                    report: agentReport,
                }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

                if (recallCfg.usageTelemetry) {
                    const usageClient = await require('../fairy/skilxivCredentials').createClient({ baseUrl: recallCfg.skilxivBaseUrl });
                    // Confirm the +1 actually reached the registry (await + log the result),
                    // so an independent record exists that the skill was used & reproduced.
                    // Identity + report are sent only when the user opted in (sharePublicly).
                    usageClient.reportUsage({
                        skill: skillRef, outcome, eventId, environmentClass: envClass,
                        agentReport: sharePublicly ? agentReport : null,
                        sharePublicly,
                        reasonCode,
                    })
                        .then(() => bus.appendEvent('skill.usage_confirmed', {
                            questId: quest.id, charmId: charm.id, skillRef, outcome, delivered: true, sharePublicly,
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {}))
                        .catch((e) => bus.appendEvent('skill.usage_failed', {
                            questId: quest.id, charmId: charm.id, skillRef,
                            error: (e && e.message) || String(e),
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {}));
                }
            }
        } catch (_) { /* usage feedback never blocks the run */ }

        // ── I13/S3: harness-detected skill gaps. The task DELIVERED (the knowledge
        // provably exists now); file demand signals for what the registry lacked.
        // S3: capability-level gaps from the triage (run Q_3VRPXL: "SU(N) generators
        // in arbitrary irreps") are filed EVEN when some other skill was consulted —
        // a marginal hit must not mask real gaps. Legacy fallback: whole-task gap
        // when recall found nothing at all (timeouts/network errors never count).
        try {
            if (terminalResult && terminalResult.status === 'delivered'
                && !charm.confidential && recallCfg.enabled && skilxivClient
                && !(metrics.skillGapNotes > 0)) {
                const taskShort = String(charm.title || charm.goal || charm.task || '').slice(0, 120);
                const gapsList = (recallResult && Array.isArray(recallResult.gaps)) ? recallResult.gaps : [];
                const legacyGapWorthy = recallResult && recallResult.mode === 'none'
                    && /no skills found|below relevance floor|triage: no candidate/i
                        .test(String((recallResult.recallLog && recallResult.recallLog.error) || ''));
                const wanted = gapsList.length
                    ? gapsList.slice(0, 2).map(g => ({
                        topic: String(g).slice(0, 200),
                        why:   `Capability needed by a DELIVERED task with no fitting registry skill (task: ${taskShort}).`,
                    }))
                    : (legacyGapWorthy ? [{
                        topic: String(charm.title || charm.goal || charm.task || '').slice(0, 200),
                        why:   `Task delivered with no suitable skill in the registry (${String(recallResult.recallLog.error).slice(0, 120)}).`,
                    }] : []);
                for (const w of wanted) {
                    const gap = await recordSkillGapFn({ ...w, source: 'harness' });
                    if (gap && gap.recorded) {
                        metrics.skillGapsAuto = (metrics.skillGapsAuto || 0) + 1;
                        await bus.appendEvent('skill.gap_recorded', {
                            questId: quest.id, charmId: charm.id, source: 'harness',
                            topic: gap.entry.topic, remote: !!gap.remote,
                        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
                    }
                }
            }
        } catch (_) { /* gap recording never blocks the run */ }

        // ── O5: run-efficiency metrics — emit even on error/abort. ───────────
        try {
            const okN = metrics.probesOk || 0, failN = metrics.probesFailed || 0;
            const totalProbes = okN + failN;
            // Stage-2 ladder telemetry: distribution of verifiedRung across the
            // final valid steps (2 = clean eval, 3 = record checks, 5 = replay).
            let verifiedRungs;
            try {
                const _vs = await workDir.loadValidSteps();
                verifiedRungs = {};
                for (const s of _vs) { const r = String(s.verifiedRung || 2); verifiedRungs[r] = (verifiedRungs[r] || 0) + 1; }
            } catch (_) {}
            await bus.appendEvent('fairy.run_metrics', {
                questId: quest.id, charmId: charm.id,
                verifiedRungs: verifiedRungs || undefined,
                probesOk: okN, probesFailed: failN,
                probeSuccessRate: totalProbes ? +(okN / totalProbes).toFixed(3) : null,
                records: metrics.records || 0,
                recordRate: okN ? +Math.min(1, (metrics.records || 0) / okN).toFixed(3) : null,
                unrecordedSuccesses: Math.max(0, okN - Math.min(okN, metrics.records || 0)),
                noteFacts: metrics.noteFacts || 0,
                amends: metrics.amends || 0,
                amendRatio: failN ? +((metrics.amends || 0) / failN).toFixed(2) : null,   // P10
                probeFailRate: totalProbes ? +(failN / totalProbes).toFixed(3) : null,   // P10
                checkpoints: metrics.checkpoints || 0,                                   // P10
                utilForkRejections: metrics.utilForkRejections || 0,                     // P10
                nearDuplicateRejections: metrics.nearDuplicateRejections || 0,           // R6 dup-probe guard
                recordGates: metrics.recordGates || 0,                                   // R10 record-rate gate
                crosscheckGates: metrics.crosscheckGates || 0,                           // B7 crosscheck gate firings
                missingDepGates: metrics.missingDepGates || 0,                           // H3 completeness gate firings
                chainReopens: metrics.chainReopens || 0,                                 // B4 polish→explore reopens
                continuations: continuations,                                            // R11 user "continue" grants
                literatureQueries: metrics.literatureQueries || 0,                       // R4 lit
                litReads: metrics.litReads || 0,                                          // I10 deep reads
                reDerivations: metrics.repeatAbandon || 0,
                inspects: metrics.inspects || 0,
                inspectsPerProbe: okN ? +((metrics.inspects || 0) / okN).toFixed(2) : null,
                recallSkill: (recallResult && recallResult.skillRef) || null,
                recallUsed: !!(recallState && recallState.cited && recallState.cited.size),
                recallInjected: !!(recallLive && recallLive.injected),                                             // I12
                recallMs: (recallResult && recallResult.recallLog && recallResult.recallLog.durationMs) || null,   // I8
                recallTopScore: (recallResult && recallResult.recallLog && recallResult.recallLog.topScore) ?? null,
                recallTriage: (recallResult && recallResult.recallLog && recallResult.recallLog.triage) || null,   // I11
                citationGates: metrics.citationGates || 0,                                                         // I16
                skillGapNotes: metrics.skillGapNotes || 0,                                                         // I20
                skillGapsAuto: metrics.skillGapsAuto || 0,                                                         // I13
                skillDraftAuthored: !!metrics.skillDraftAuthored,                                                  // I14
                llmCalls: metrics.llmCalls || 0,                                                                   // O11
                runCapHits: metrics.runCapHits || 0,
                // 2026-08-02 efficiency-tranche counters (their absence slowed
                // the baselineff diagnosis — keep run_metrics the one-stop view)
                thinkingTurns: metrics.thinkingTurns || 0,
                autoRecords: metrics.autoRecords || 0,
                lengthStops: metrics.lengthStops || 0,
                lengthStopRecoveries: metrics.lengthStopRecoveries || 0,
                reasoningOverruns: metrics.reasoningOverruns || 0,
                fixGateRejections: metrics.fixGateRejections || 0,
                // C1: every harness gate that rejected a call this run, by kind.
                // Read this FIRST when a run underperforms — a gate firing dozens
                // of times is the harness fighting the model, not the model failing.
                gateRejections: metrics.gateRejections || undefined,
                lessonsRecorded: metrics.lessonsRecorded || 0,
                unrecordedNudges: metrics.unrecordedNudges || 0,
                essayTruncations: metrics.essayTruncations || 0,
                tricksShown: metrics.tricksShown || 0,
                tricksResolved: metrics.tricksResolved || 0,
                unmatchedTrickSigs: metrics.unmatchedTrickSigs || 0,
                handoffUtils: (args.handoff && (args.handoff.utils || []).length) || 0,                            // O6
                build: BUILD_INFO,                                                                                 // I18
                cacheHitRate: (metrics.cacheRead || metrics.cacheMiss)                                             // O3
                    ? +((metrics.cacheRead || 0) / ((metrics.cacheRead || 0) + (metrics.cacheMiss || 0))).toFixed(3)
                    : null,
                candidateRaised: !!metrics.candidateRaised,
                status: (terminalResult && terminalResult.status) || 'unknown',
            }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});
        } catch (_) { /* metrics never block the run */ }

        // P7: terminal status — swap the live status cell to a final ✅/▢ line.
        bus.appendEvent('fairy.status', {
            questId: quest.id, charmId: charm.id, charmDir: workDir.dir,
            done: true, status: (terminalResult && terminalResult.status) || 'unknown',
        }, { spanId, questId: quest.id, charmId: charm.id }).catch(() => {});

        // M6: clear the post-restart seeder now the run is over (next run re-registers).
        wolframShim.setPostRestartSeeder(null);
    }

    // O6: export the verified utils + established facts for the next charm in a
    // multi-charm quest (research.js threads this into the next runFairy call).
    let handoffOut = null;
    try {
        const [hUtils, hFacts] = await Promise.all([
            workDir.loadUtils().catch(() => []),
            workDir.loadFacts().catch(() => []),
        ]);
        if (hUtils.length || hFacts.length) handoffOut = { utils: hUtils, facts: hFacts };
    } catch (_) {}

    return {
        scroll,
        fileRef,
        // Terminal status from the Fairy's own clean.wb run — the verification
        // signal Oberon derives its verdict from (delivered = clean replay).
        status:         (scroll && scroll.fairyArtifact && scroll.fairyArtifact.status) || 'escalate',
        workingNbPath:  workDir.workingNb,
        cleanNbPath:    scroll && scroll.fairyArtifact && scroll.fairyArtifact.cleanNbPath    || null,
        partialNbPath:  scroll && scroll.fairyArtifact && scroll.fairyArtifact.partialNbPath  || null,
        handoff:        handoffOut,
    };
}

module.exports = {
    runFairy,
    SteerQueue,
    _internals: {
        tryParseControlSignal, tryParseJson, resolveCharmDir, findRecordedValue, buildAndPersistScroll,
        buildEvidenceFromSteps,
        buildSkillAuthorPrompt, parseSkillAuthorReply, composeSkillDraftMd, BUILD_INFO,
        appendToLastToolOrUser, collapseFailed, compactMessages, extractTargetSymbol, shouldAutoCheckpoint,
        findSafeTailStart, sanitizeToolPairing, estimateContextChars,
    },
};
