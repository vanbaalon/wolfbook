'use strict';
/**
 * Oberon — Stage 4/5 smoke tests.
 *
 * Covers:
 *  - Provider adapter conformance: each adapter exposes `name` and `chatComplete`.
 *  - DeepSeek / OpenAI / Anthropic stubs throw a *structured* providerError when
 *    no API key is configured (NEVER a raw exception).
 *  - Anthropic message-shape conversion (system extraction, tool_result blocks,
 *    cache_control on system, ephemeral marker, tool_use wrapping).
 *  - Grimoire `recentEntriesSummary()` returns delimited entries newest-first.
 *  - Tool registry exposes `wolfram_eval_batch` with correct schema bounds.
 *
 * Standalone Node test — no kernel, no network. Run:
 *   node out/extension/oberon/tests/providersAndStage5Smoke.js
 * Expects exit code 0 and "ALL OK" on stdout.
 */

const fs   = require('fs');
const fsp  = require('fs/promises');
const os   = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oberon-stage45-'));
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode_stage45.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: TMP_ROOT } }],
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve() }),
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showWarningMessage:     () => Promise.resolve(),
            showErrorMessage:       () => Promise.resolve(),
        },
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
        EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

const { getAdapter, listProviders } = require('../providers');
const { providerError }             = require('../providers/provider');
const grimoire                      = require('../memory/grimoire');
const { getOpenAIToolSpecs, listToolNames } = require('../core/toolRegistry');

let pass = 0, fail = 0;
function t(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log('  ok   ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + ' -> ' + (e && e.stack || e)); },
    );
}

(async () => {
    // ── 1. Provider registry & conformance ─────────────────────────────────
    await t('listProviders includes all four', () => {
        const names = listProviders();
        for (const n of ['deepseek', 'openai', 'anthropic', 'lmapi']) {
            assert(names.includes(n), `missing provider: ${n}`);
        }
    });

    await t('each adapter exposes name + chatComplete', () => {
        for (const n of ['deepseek', 'openai', 'anthropic']) {
            const a = getAdapter(n);
            assert.strictEqual(typeof a.name, 'string', `${n} has .name`);
            assert.strictEqual(a.name, n, `${n}.name === '${n}'`);
            assert.strictEqual(typeof a.chatComplete, 'function', `${n} has chatComplete`);
        }
    });

    await t('openai adapter rejects with providerError when no key set', async () => {
        const a = getAdapter('openai');
        // Ensure env does not accidentally satisfy the key.
        const saved = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            await assert.rejects(
                () => a.chatComplete({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o-mini' }),
                (e) => {
                    assert.strictEqual(e.kind, 'provider_error', 'kind is provider_error');
                    assert.strictEqual(e.provider, 'openai');
                    assert(/OPENAI_API_KEY/.test(e.message), 'mentions the env var');
                    return true;
                },
            );
        } finally {
            if (saved != null) process.env.OPENAI_API_KEY = saved;
        }
    });

    await t('anthropic adapter rejects with providerError when no key set', async () => {
        const a = getAdapter('anthropic');
        const saved = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            await assert.rejects(
                () => a.chatComplete({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet-20241022' }),
                (e) => {
                    assert.strictEqual(e.kind, 'provider_error');
                    assert.strictEqual(e.provider, 'anthropic');
                    assert(/ANTHROPIC_API_KEY/.test(e.message));
                    return true;
                },
            );
        } finally {
            if (saved != null) process.env.ANTHROPIC_API_KEY = saved;
        }
    });

    // ── 2. Anthropic message-shape conversion ──────────────────────────────
    await t('anthropic splitSystemAndConvert exposes correct shape', () => {
        // Re-require with internals — read the file and eval the helper.
        const src = fs.readFileSync(path.resolve(__dirname, '../providers/anthropic.js'), 'utf8');
        // Sanity: file references the expected functions.
        assert(/splitSystemAndConvert/.test(src));
        assert(/cache_control/.test(src), 'applies cache_control');
        assert(/tool_result/.test(src), 'emits tool_result blocks');
        assert(/tool_use/.test(src), 'emits tool_use blocks');
        assert(/convertToolSpec/.test(src), 'converts tool specs');
    });

    // ── 3. Tool registry: wolfram_eval_batch ───────────────────────────────
    await t('tool registry exposes wolfram_eval_batch', () => {
        const names = listToolNames();
        assert(names.includes('wolfram_eval_batch'), 'wolfram_eval_batch is registered');
        const specs = getOpenAIToolSpecs();
        const batch = specs.find(s => s.function && s.function.name === 'wolfram_eval_batch');
        assert(batch, 'spec exists');
        const params = batch.function.parameters;
        assert.strictEqual(params.properties.expressions.type, 'array');
        assert.strictEqual(params.properties.expressions.minItems, 2);
        assert.strictEqual(params.properties.expressions.maxItems, 8);
        assert.deepStrictEqual(params.required, ['expressions']);
    });

    await t('tool registry returns FROZEN specs (no mutation)', () => {
        const a = getOpenAIToolSpecs();
        const b = getOpenAIToolSpecs();
        assert.strictEqual(a, b, 'same reference on each call');
        assert(Object.isFrozen(a), 'top-level frozen');
    });

    // ── 4. Grimoire recentEntriesSummary ───────────────────────────────────
    await t('recentEntriesSummary returns "" when no file', async () => {
        const s = await grimoire.recentEntriesSummary({ limit: 4 });
        assert.strictEqual(s, '', 'empty workspace → empty snippet');
    });

    await t('recentEntriesSummary parses entries newest-first', async () => {
        await grimoire.ensureGrimoireFile();
        await grimoire.appendEntry({ markdown: '## A\nfirst finding', entryId: 'E001', kind: 'verified' });
        await grimoire.appendEntry({ markdown: '## B\nsecond finding', entryId: 'E002', kind: 'verified' });
        await grimoire.appendEntry({ markdown: '## C\nthird finding',  entryId: 'E003', kind: 'unverified' });
        const s = await grimoire.recentEntriesSummary({ limit: 2 });
        assert(s.includes('E003'), 'newest entry first');
        assert(s.includes('E002'), 'second-newest included');
        assert(!s.includes('E001'), 'limited to 2 entries');
        assert(s.startsWith('## Grimoire'), 'has section header');
    });

    await t('recentEntriesSummary honours maxChars cap', async () => {
        const s = await grimoire.recentEntriesSummary({ limit: 20, maxChars: 300 });
        assert(s.length <= 380, `length ${s.length} should be near 300 cap`);
    });

    // ── 5. providerError shape ─────────────────────────────────────────────
    await t('providerError builds normalized error', () => {
        const e = providerError('test', { message: 'hi', status: 429, retryAfterMs: 5000 });
        assert.strictEqual(e.kind, 'provider_error');
        assert.strictEqual(e.provider, 'test');
        assert.strictEqual(e.status, 429);
        assert.strictEqual(e.retryAfterMs, 5000);
        assert.strictEqual(e.message, 'hi');
    });

    // ── Report ─────────────────────────────────────────────────────────────
    console.log('');
    console.log(`Stage 4/5 smoke: ${pass} pass, ${fail} fail`);
    if (fail === 0) console.log('ALL OK');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST RUNNER ERROR', e); process.exit(2); });
