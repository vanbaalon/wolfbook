'use strict';
/**
 * Stage 5 — memory, toolset & SkilXiv round-2 (FAIRY_MEMORY_AND_TOOLSET_R2_22JUN.md):
 *  5R2  — facts ledger (workDir) + note_fact handler
 *  5R3  — buildDefinitionsLedger (verbatim, compaction-safe)
 *  5R1  — amend_probe (reuse probeId, reject when nothing to amend)
 *  5R5  — extractRecallSymbols
 *  5R6  — SkilXivClient.contribute exists
 *  5R8  — richer structural summary (matrix dims, corner elements)
 *  5R9  — record persists confidence/verifiedBy; ledger marks high confidence
 *  5R10 — run metrics shape (derived rates)
 *  spec — note_fact + amend_probe present in tool specs
 */

const assert  = require('assert');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const Module  = require('module');

// ── vscode stub ──────────────────────────────────────────────────────────────

const fakeVscodeId = path.resolve(__dirname, '..', 'vscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            getConfiguration: () => ({ get: () => undefined }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
        },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
        EventEmitter: class { constructor() { this.event = () => {}; } on() {} off() {} fire() {} },
        Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
    },
};
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (req, parent, isMain, opts) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve(req, parent, isMain, opts);
};

// ── harness ──────────────────────────────────────────────────────────────────

let passCount = 0, failCount = 0;
const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); passCount++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, err: e }); failCount++; }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-')); }

// ── modules under test ───────────────────────────────────────────────────────

const { createWorkDir } = require('../fairy/workDir');
const {
    handleNoteFact, handleAmendProbe, handleProbe, handleRecord, computeStructuralSummary,
} = require('../fairy/tools');
const { FAIRY_TOOL_SPECS, EXPLORE_FAIRY_TOOL_SPECS, FAILED_PROBE_TOOL_SPECS } = require('../fairy/toolSpecs');
const { _internals } = require('../core/fairy');
const { SkilXivClient } = require('../fairy/skilxivClient');

function makeShim(nextResult) {
    const shim = {
        DEFAULT_TIMEOUT: 30,
        _next: nextResult || { ok: true, value: 'Null', messages: [] },
        async evalOnce({ expression }) { shim._lastExpression = expression; return shim._next; },
    };
    return shim;
}
async function makeCtx(label, opts = {}) {
    const wd = await createWorkDir(tmpDir());
    return {
        workDir: wd,
        shim: makeShim(opts.shimResult),
        signal: null,
        rejectRedefinition: opts.rejectRedefinition,
        lastProbeId: opts.lastProbeId,
        lastProbeFailed: opts.lastProbeFailed,
        fsm: { canTurn: () => true, turnsUsed: 0, exploreProbesRemaining: 10 },
    };
}

// ── 5R2 facts ─────────────────────────────────────────────────────────────────

async function run5R2() {
    console.log('\n── 5R2: facts ledger + note_fact ──');

    await ok('5R2: factsFile path', async () => {
        const ctx = await makeCtx('p'); assert.ok(ctx.workDir.factsFile.endsWith('facts.json'));
    });
    await ok('5R2: loadFacts empty by default', async () => {
        const ctx = await makeCtx('e'); assert.deepStrictEqual(await ctx.workDir.loadFacts(), []);
    });
    await ok('5R2: addFact persists + upserts by key', async () => {
        const ctx = await makeCtx('a');
        await ctx.workDir.addFact({ key: 'eigs', value: '{1,2}', confidence: 'high', provenance: 'p003' });
        await ctx.workDir.addFact({ key: 'eigs', value: '{1,2,3}' });
        const facts = await ctx.workDir.loadFacts();
        assert.strictEqual(facts.length, 1);
        assert.strictEqual(facts[0].value, '{1,2,3}');
    });
    await ok('5R2: buildFactsLedger lists + sorts high first', async () => {
        const ctx = await makeCtx('l');
        await ctx.workDir.addFact({ key: 'low1',  value: 'v', confidence: 'low' });
        await ctx.workDir.addFact({ key: 'high1', value: 'v', confidence: 'high' });
        const led = await ctx.workDir.buildFactsLedger();
        assert.ok(led.indexOf('high1') < led.indexOf('low1'), 'high should sort first');
        assert.ok(led.includes('[high]'));
    });
    await ok('5R2: handleNoteFact saves and returns ok', async () => {
        const ctx = await makeCtx('h');
        const r = await handleNoteFact({ key: 'k', value: 'v', confidence: 'high', provenance: 'p001' }, ctx);
        assert.ok(r.ok !== false, r.error);
        assert.strictEqual((await ctx.workDir.loadFacts())[0].key, 'k');
    });
    await ok('5R2: handleNoteFact rejects missing key/value', async () => {
        const ctx = await makeCtx('h2');
        assert.strictEqual((await handleNoteFact({ value: 'v' }, ctx)).ok, false);
        assert.strictEqual((await handleNoteFact({ key: 'k' }, ctx)).ok, false);
    });
}

// ── 5R3 definitions ledger ─────────────────────────────────────────────────────

async function run5R3() {
    console.log('\n── 5R3: buildDefinitionsLedger (verbatim) ──');

    await ok('5R3: empty when nothing defined', async () => {
        const wd = await createWorkDir(tmpDir());
        assert.strictEqual(await wd.buildDefinitionsLedger(), '');
    });
    await ok('5R3: includes util body verbatim', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.addUtil({ name: 'foo', code: 'foo[x_]:=x^2+1', note: 'sq' });
        const led = await wd.buildDefinitionsLedger();
        assert.ok(led.includes('foo[x_]:=x^2+1'), led);
    });
    await ok('5R3: includes recorded step code verbatim', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.addStep({ id: 's001', probeId: 'p001', code: 'Hmat = {{1,0},{0,1}}', resultRef: 'p001',
            dependsOn: [], usesSymbols: [], definesSymbols: ['Hmat'], note: 'H' });
        const led = await wd.buildDefinitionsLedger();
        assert.ok(led.includes('Hmat = {{1,0},{0,1}}'), led);
        assert.ok(led.includes('s001'), led);
    });
}

// ── 5R1 amend_probe ─────────────────────────────────────────────────────────────

async function run5R1() {
    console.log('\n── 5R1: amend_probe ──');

    await ok('5R1: rejects when no prior probe', async () => {
        const ctx = await makeCtx('np');
        const r = await handleAmendProbe({ code: '2+2' }, ctx);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.kind, 'nothing_to_amend');
    });
    await ok('5R1: amend now REFINES a successful probe in place (R6)', async () => {
        // Changed in R6: amend works on a successful-but-unsatisfactory probe too
        // (e.g. force numeric), not only on a failure. It delegates to handleProbe.
        const ctx = await makeCtx('ps', {
            shimResult: { ok: true, value: '4', messages: [] },
            lastProbeId: 'p001', lastProbeFailed: false,
        });
        const r = await handleAmendProbe({ code: 'N[2+2]', note: 'force numeric' }, ctx);
        assert.ok(r.ok !== false, r.error);
        assert.strictEqual(r.amended, true);
    });
    await ok('5R1: reuses the prior probeId on amend', async () => {
        const ctx = await makeCtx('reuse', {
            shimResult: { ok: true, value: '4', messages: [] },
            lastProbeId: 'p001', lastProbeFailed: true,
        });
        const r = await handleAmendProbe({ code: '2+2', note: 'fixed typo' }, ctx);
        assert.ok(r.ok !== false, r.error);
        assert.strictEqual(r.probeId, 'p001', 'must reuse p001');
        assert.strictEqual(r.amended, true);
    });
    await ok('5R1: rejects empty code', async () => {
        const ctx = await makeCtx('ec', { lastProbeId: 'p001', lastProbeFailed: true });
        assert.strictEqual((await handleAmendProbe({ code: '' }, ctx)).ok, false);
    });
}

// ── 5R5 cite_skill (replaces removed token heuristic) ───────────────────────────

async function run5R5() {
    console.log('\n── 5R5: cite_skill (skill attribution) ──');
    const { handleCiteSkill } = require('../fairy/tools');

    await ok('5R5: cite_skill persists the citation', async () => {
        const ctx = await makeCtx('cite-ok');
        ctx.recalledSkillRefs = ['@n/s@1'];
        const r = await handleCiteSkill({ skillRef: '@n/s@1', how: 'used its Legendre relation' }, ctx);
        assert.ok(r.ok !== false, r.error);
        const cited = await ctx.workDir.loadCitedSkills();
        assert.strictEqual(cited.length, 1);
        assert.strictEqual(cited[0].skillRef, '@n/s@1');
        assert.ok(cited[0].how.includes('Legendre'));
    });
    await ok('5R5: cite_skill rejects a non-recalled skill', async () => {
        const ctx = await makeCtx('cite-bad');
        ctx.recalledSkillRefs = ['@n/s@1'];
        const r = await handleCiteSkill({ skillRef: '@other/x@1', how: 'nope' }, ctx);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.kind, 'not_recalled');
    });
    await ok('5R5: cite_skill requires skillRef + how', async () => {
        const ctx = await makeCtx('cite-args');
        assert.strictEqual((await handleCiteSkill({ how: 'x' }, ctx)).ok, false);
        assert.strictEqual((await handleCiteSkill({ skillRef: '@n/s@1' }, ctx)).ok, false);
    });
}

// ── 5R6 → Stage 2 createDraft ───────────────────────────────────────────────────

async function run5R6() {
    console.log('\n── 5R6/S2: SkilXivClient.createDraft ──');

    await ok('S2: createDraft method exists', async () => {
        const c = new SkilXivClient({ baseUrl: 'https://x', apiToken: '' });
        assert.strictEqual(typeof c.createDraft, 'function');
    });
    await ok('S2: createDraft posts to /api/v1/drafts with skill_md + idempotency key', async () => {
        const c = new SkilXivClient({ baseUrl: 'https://x', apiToken: 't' });
        let captured = null;
        global.fetch = async (url, opts) => {
            captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
            return { ok: true, json: async () => ({ id: 'draft_1' }) };
        };
        const r = await c.createDraft({ skillMd: '---\nname: t\n---\n# T', agentModel: 'm', idempotencyKey: 'k1' });
        assert.ok(captured.url.endsWith('/api/v1/drafts'), captured.url);
        assert.ok(captured.body.skill_md.includes('# T'));
        assert.strictEqual(captured.headers['Idempotency-Key'], 'k1');
        assert.strictEqual(r.id, 'draft_1');
        delete global.fetch;
    });

    await ok('S2: reportUsage sends agent_report + share_publicly when opted in', async () => {
        const c = new SkilXivClient({ baseUrl: 'https://x', apiToken: 't' });
        let body = null;
        global.fetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; };
        await c.reportUsage({ skill: '@n/s@1', outcome: 'used_reproduced', eventId: 'e', environmentClass: 'WL', agentReport: 'did X', sharePublicly: true });
        delete global.fetch;
        assert.strictEqual(body.share_publicly, true);
        assert.strictEqual(body.agent_report, 'did X');
        assert.strictEqual(body.outcome, 'used_reproduced');
    });

    await ok('S2: reportUsage defaults to private (no report)', async () => {
        const c = new SkilXivClient({ baseUrl: 'https://x', apiToken: 't' });
        let body = null;
        global.fetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; };
        await c.reportUsage({ skill: '@n/s@1', outcome: 'consulted', eventId: 'e', environmentClass: 'WL' });
        delete global.fetch;
        assert.strictEqual(body.share_publicly, false);
        assert.strictEqual(body.agent_report, null);
    });
}

// ── 5R8 richer structural summary ───────────────────────────────────────────────

async function run5R8() {
    console.log('\n── 5R8: richer structural summary ──');

    await ok('5R8: matrix dims for nested list', async () => {
        const s = computeStructuralSummary('{{1, 2, 3}, {4, 5, 6}}');
        assert.strictEqual(s.matrixDims, '2×3', JSON.stringify(s));
    });
    await ok('5R8: flat list reports depth + corner elements', async () => {
        const s = computeStructuralSummary('{10, 20, 30, 40}');
        assert.strictEqual(s.elementCount, 4);
        assert.strictEqual(s.depth, 1);
        assert.ok(String(s.firstElement).includes('10'));
        assert.ok(String(s.lastElement).includes('40'));
    });
}

// ── 5R9 confidence ──────────────────────────────────────────────────────────────

async function run5R9() {
    console.log('\n── 5R9: confidence-tagged record ──');

    await ok('5R9: record persists confidence + verifiedBy', async () => {
        const ctx = await makeCtx('rc', { shimResult: { ok: true, value: '4', messages: null } });
        // First a clean probe to record
        const p = await handleProbe({ code: 'cVal = 2 + 2', note: 'sum' }, ctx);
        assert.ok(p.ok !== false, p.error);
        const r = await handleRecord({
            stepId: 'step_sum', probeId: p.probeId, confidence: 'high', verifiedBy: 'cross-checked',
        }, ctx);
        assert.ok(r.ok !== false, r.error);
        const steps = await ctx.workDir.loadValidSteps();
        assert.strictEqual(steps[0].confidence, 'high');
        assert.strictEqual(steps[0].verifiedBy, 'cross-checked');
    });
    await ok('5R9: symbol table marks high-confidence as [established]', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.addStep({ id: 's001', probeId: 'p001', code: 'a=1', resultRef: 'p001',
            dependsOn: [], usesSymbols: [], definesSymbols: ['a'], note: 'x', confidence: 'high' });
        const tbl = await wd.buildSymbolTable();
        assert.ok(tbl.includes('[established]'), tbl);
    });
}

// ── spec presence ───────────────────────────────────────────────────────────────

async function runSpec() {
    console.log('\n── spec: note_fact + amend_probe ──');

    await ok('spec: note_fact in FAIRY_TOOL_SPECS', async () => {
        assert.ok(FAIRY_TOOL_SPECS.some(t => t.function.name === 'note_fact'));
    });
    await ok('spec: amend_probe in FAIRY_TOOL_SPECS', async () => {
        assert.ok(FAIRY_TOOL_SPECS.some(t => t.function.name === 'amend_probe'));
    });
    await ok('spec: both in EXPLORE set', async () => {
        const names = EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('note_fact') && names.includes('amend_probe'), names.join(','));
    });
    await ok('spec: amend_probe in FAILED_PROBE set (R7)', async () => {
        const names = FAILED_PROBE_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('amend_probe'), names.join(','));
    });
    await ok('spec: record has confidence enum', async () => {
        const rec = FAIRY_TOOL_SPECS.find(t => t.function.name === 'record');
        assert.deepStrictEqual(rec.function.parameters.properties.confidence.enum, ['high', 'medium', 'low']);
    });
}

// ── S2 contribution inbox (eligibility + candidate) ─────────────────────────────

async function runS2Inbox() {
    console.log('\n── S2: contribution inbox eligibility ──');
    const inbox = require('../memory/contributionInbox');

    await ok('S2: delivered + definitions → eligible', async () => {
        const e = inbox.evaluateEligibility({ status: 'delivered', hasDefinitions: true, factsCount: 0, inputs: ['x'] });
        assert.strictEqual(e.eligible, true, e.reasons.join(','));
    });
    await ok('S2: confidential → not eligible', async () => {
        const e = inbox.evaluateEligibility({ status: 'delivered', confidential: true, hasDefinitions: true, factsCount: 1 });
        assert.strictEqual(e.eligible, false);
        assert.ok(e.reasons.some(r => /confidential/.test(r)));
    });
    await ok('S2: not delivered → not eligible', async () => {
        const e = inbox.evaluateEligibility({ status: 'failed', hasDefinitions: true, factsCount: 1 });
        assert.strictEqual(e.eligible, false);
    });
    await ok('S2: no definitions or facts → not eligible', async () => {
        const e = inbox.evaluateEligibility({ status: 'delivered', hasDefinitions: false, factsCount: 0, inputs: [] });
        assert.strictEqual(e.eligible, false);
    });
    await ok('S2: renderSkillMd produces valid frontmatter + sections', async () => {
        const md = inbox.renderSkillMd({
            title: 'Bethe roots SU(2)', task: 'find roots',
            definitionsLedger: 'f[x_]:=x', factsLedger: '[high] roots = {0}',
        });
        assert.ok(md.startsWith('---'), 'frontmatter');
        assert.ok(md.includes('visibility: private'), 'private by default');
        assert.ok(md.includes('## Verified definitions'));
        assert.ok(md.includes('## Established results'));
    });
    await ok('S2: slug is filesystem-safe', async () => {
        assert.strictEqual(inbox.slug('SU(2) Bethe roots!'), 'su-2-bethe-roots');
    });
}

// ── S2 submit handler (token, status transitions, near-dup) ─────────────────────

function fakeSecrets() {
    const m = new Map();
    return {
        get: async (k) => m.get(k),
        store: async (k, v) => { m.set(k, v); },
        delete: async (k) => { m.delete(k); },
    };
}

async function runS2Submit() {
    console.log('\n── S2: submit handler ──');
    const submit = require('../memory/contributionSubmit');
    const inbox  = require('../memory/contributionInbox');
    const project = require('../memory/project');

    // Point the inbox at a temp workspace by stubbing project.contributionsInboxDir.
    const tmp = tmpDir();
    const origInboxDir = project.contributionsInboxDir;
    project.contributionsInboxDir = () => path.join(tmp, 'inbox');

    try {
        await ok('S2: token round-trips through secret storage', async () => {
            const sec = fakeSecrets();
            assert.strictEqual(await submit.isSignedIn(sec), false);
            await submit.setToken(sec, 'tok_123');
            assert.strictEqual(await submit.isSignedIn(sec), true);
            assert.strictEqual(await submit.getToken(sec), 'tok_123');
            await submit.clearToken(sec);
            assert.strictEqual(await submit.isSignedIn(sec), false);
        });

        await ok('S2: submit without token → not_signed_in', async () => {
            const cand = await inbox.writeCandidate({
                charmId: 'C01', questId: 'Q', title: 'T', task: 'do it', status: 'delivered',
                definitionsLedger: 'f[x_]:=x', factsLedger: '', factsCount: 0, inputs: ['x'],
            });
            const res = await submit.submitCandidate({ id: cand.id, secrets: fakeSecrets() });
            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.error, 'not_signed_in');
        });

        await ok('S2: submit posts createDraft + marks candidate submitted', async () => {
            const cand = await inbox.writeCandidate({
                charmId: 'C02', questId: 'Q', title: 'T2', task: 'do', status: 'delivered',
                definitionsLedger: 'g[x_]:=x', factsLedger: '', factsCount: 0, inputs: ['x'],
            });
            const sec = fakeSecrets(); await submit.setToken(sec, 'tok');
            let captured = null;
            global.fetch = async (url, opts) => {
                captured = { url, headers: opts.headers };
                return { ok: true, json: async () => ({ id: 'draft_42' }) };
            };
            const res = await submit.submitCandidate({ id: cand.id, secrets: sec });
            delete global.fetch;
            assert.ok(res.ok, res.error);
            assert.strictEqual(res.draftId, 'draft_42');
            assert.ok(captured.url.endsWith('/api/v1/drafts'));
            assert.strictEqual(captured.headers['Idempotency-Key'], cand.id);
            const loaded = await submit.loadCandidate(cand.id);
            assert.strictEqual(loaded.manifest.status, 'submitted');
            assert.strictEqual(loaded.manifest.draftId, 'draft_42');
        });

        await ok('S2: decline marks declined; discard deletes', async () => {
            const cand = await inbox.writeCandidate({
                charmId: 'C03', questId: 'Q', title: 'T3', task: 'do', status: 'delivered',
                definitionsLedger: 'h[x_]:=x', factsLedger: '', factsCount: 0, inputs: ['x'],
            });
            await submit.declineCandidate(cand.id);
            assert.strictEqual((await submit.loadCandidate(cand.id)).manifest.status, 'declined');
            await submit.discardCandidate(cand.id);
            assert.strictEqual(await submit.loadCandidate(cand.id), null);
        });

        await ok('S2: nearDuplicateCheck flags a strong match', async () => {
            global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ ref: '@x/y', score: 0.92, summary: 's' }] }) });
            const { match } = await submit.nearDuplicateCheck('tok', { title: 'T', task: 'x' });
            delete global.fetch;
            assert.ok(match && match.ref === '@x/y');
        });

        await ok('S2: nearDuplicateCheck ignores a weak match', async () => {
            global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ ref: '@x/y', score: 0.3 }] }) });
            const { match } = await submit.nearDuplicateCheck('tok', { title: 'T', task: 'x' });
            delete global.fetch;
            assert.strictEqual(match, null);
        });
    } finally {
        project.contributionsInboxDir = origInboxDir;
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    for (const s of [run5R2, run5R3, run5R1, run5R5, run5R6, run5R8, run5R9, runS2Inbox, runS2Submit, runSpec]) await s();
    console.log(`\n── Stage 5 Results: ${passCount} passed, ${failCount} failed ──`);
    if (failures.length) {
        for (const { label, err } of failures) {
            console.error(`  [FAIL] ${label}`);
            if (err && err.stack) console.error('    ' + err.stack.split('\n').join('\n    '));
        }
        process.exit(1);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
