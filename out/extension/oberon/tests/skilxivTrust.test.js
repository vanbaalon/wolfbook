'use strict';
const assert = require('assert');
const { SkilXivClient, normaliseBaseUrl, hashSkillBody } = require('../fairy/skilxivClient');
const { runRecall } = require('../fairy/recall');
const { passesVersionFilter } = require('../fairy/recall');
const credentials = require('../fairy/skilxivCredentials');
const { fetchRef } = require('../fairy/skilxivRef');

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok ${name}`); }
    catch (e) { console.error(`  FAIL ${name}: ${e.stack || e}`); process.exitCode = 1; }
}
function response(body, { status = 200, contentType = 'application/json', length } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status,
        headers: { get: k => k === 'content-type' ? contentType : k === 'content-length' ? String(length == null ? Buffer.byteLength(text) : length) : '' },
        text: async () => text };
}

(async () => {
    console.log('\n── SkilXiv trust substrate ──');
    await test('rejects insecure remote origins', () => assert.throws(() => normaliseBaseUrl('http://example.com'), /HTTPS/));
    await test('allows HTTPS and strips trailing slash', () => assert.strictEqual(normaliseBaseUrl('https://example.com/'), 'https://example.com'));
    await test('hash is deterministic and prefixed', () => assert.match(hashSkillBody('abc'), /^sha256:[a-f0-9]{64}$/));
    await test('transport rejects oversized declared responses', async () => {
        global.fetch = async () => response({}, { length: 100 });
        const c = new SkilXivClient({ baseUrl: 'https://x.test', maxResponseBytes: 10 });
        await assert.rejects(() => c.search('x'), e => e.code === 'response_too_large');
        delete global.fetch;
    });
    await test('transport aborts an in-flight request', async () => {
        global.fetch = (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        const c = new SkilXivClient({ baseUrl: 'https://x.test', timeoutMs: 20 });
        await assert.rejects(() => c.search('x'), e => e.code === 'aborted');
        delete global.fetch;
    });
    await test('recall rejects a body whose advertised hash differs', async () => {
        const client = {
            search: async () => ({ results: [{ namespace: 'n', name: 's', version: '1', score: 0.9, content_hash: hashSkillBody('different') }] }),
            getSkill: async () => ({ body: '# actual' }),
        };
        const r = await runRecall('task', { client, timeoutMs: 1000 });
        assert.strictEqual(r.mode, 'none');
        assert.strictEqual(r.recallLog.integrityErrors.length, 1);
    });
    await test('credential keys are isolated by registry origin', () => {
        assert.notStrictEqual(credentials.keyFor('https://a.example'), credentials.keyFor('https://b.example'));
        assert.strictEqual(credentials.keyFor('https://a.example/path'), credentials.keyFor('https://a.example'));
    });
    await test('mutable Explorer references resolve to an immutable version', async () => {
        const body = '# method';
        const client = { getSkill: async () => ({ version: '1.2.3', body, content_hash: hashSkillBody(body) }) };
        const result = await fetchRef(client, '@n/s');
        assert.strictEqual(result.ref, '@n/s@1.2.3');
        assert.strictEqual(result.contentHash, hashSkillBody(body));
    });
    await test('semantic Wolfram ranges do not confuse 14.1 with 14.10', () => {
        assert.strictEqual(passesVersionFilter({ wolfram_versions: '>=14.1 <14.2' }, '14.10'), false);
        assert.strictEqual(passesVersionFilter({ wolfram_versions: '>=14.1 <15' }, '14.10'), true);
    });
    await test('capability-first retrieval finds a skill absent from full-task search', async () => {
        const searches = [];
        const client = {
            search: async q => {
                searches.push(q);
                if (/transfer matrix/i.test(q)) return { results: [{ namespace: 'n', name: 'transfer', version: '1', score: 0.88, summary: 'Transfer-matrix construction' }] };
                return { results: [{ namespace: 'n', name: 'generic', version: '1', score: 0.40, summary: 'Generic algebra' }] };
            },
            getSkill: async (_n, name) => ({ body: `# ${name}` }),
        };
        let calls = 0;
        const llm = async () => ++calls === 1
            ? JSON.stringify({ capabilities: ['transfer matrix construction'] })
            : JSON.stringify({ capabilities: ['transfer matrix construction'], picks: [{ index: 0, capability: 'transfer matrix construction', fit: 'exact' }], gaps: [] });
        const result = await runRecall('solve an integrable chain', { client, llm, timeoutMs: 1000 });
        assert.ok(searches.some(x => /transfer matrix/i.test(x)));
        assert.strictEqual(result.skillRef, '@n/transfer@1');
        assert.strictEqual(result.recallLog.searchQueries, 2);
    });
    await test('unsafe advisory blocks immutable reference use', async () => {
        const client = {
            getSkill: async () => ({ version: '1', body: '# unsafe' }),
            request: async () => ({ advisories: [{ status: 'unsafe', summary: 'compromised instructions' }] }),
        };
        await assert.rejects(() => fetchRef(client, '@n/s'), /blocked.*unsafe/i);
    });
    await test('capability discovery is cached', async () => {
        let calls = 0;
        global.fetch = async () => { calls++; return response({ api_version: 'v1', advisories: true }); };
        const client = new SkilXivClient({ baseUrl: 'https://x.test' });
        assert.strictEqual((await client.discover()).advisories, true);
        await client.discover();
        assert.strictEqual(calls, 1);
        delete global.fetch;
    });
    await test('autonomous recall rejects an unsafe selected skill', async () => {
        const client = {
            search: async () => ({ results: [{ namespace: 'n', name: 's', version: '1', score: 0.9 }] }),
            getSkill: async () => ({ body: '# method', version: '1' }),
            request: async () => ({ advisories: [{ status: 'revoked', summary: 'bad release' }] }),
        };
        const result = await runRecall('task', { client, timeoutMs: 1000 });
        assert.strictEqual(result.mode, 'none');
        assert.match(result.recallLog.error, /bodies failed/i);
    });
    if (!process.exitCode) console.log(`\n── SkilXiv trust results: ${passed} passed ──`);
})();
