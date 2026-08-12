'use strict';
/**
 * Round 3 — skill-workflow improvements (run Q_38X439 analysis, 2026-07-02):
 *
 *  I11 — recall triage: LLM judges ALL candidates; "none" → mode none (gap signal);
 *        recallLog carries candidates + triage verdict.
 *  I12 — non-blocking recall support: cite_skill accepts late-pushed refs.
 *  I13 — skillGaps ledger: record, dedupe, best-effort remote request.
 *  I14 — skill-draft author: prompt/parse/compose round-trip.
 *  I19 — record auto-tags crosscheck-looking steps.
 *  I20 — note_skill_gap handler validation + recorder wiring.
 *
 * Run: node out/extension/oberon/tests/run3Skills.test.js
 */

const assert = require('assert');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

// ── vscode stub ──────────────────────────────────────────────────────────────
const fakeVscodeId = path.resolve(__dirname, '..', 'vscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            getConfiguration: () => ({ get: () => undefined }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
            notebookDocuments: [],
            workspaceFolders: [],
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

let passCount = 0, failCount = 0;
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); passCount++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failCount++; }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'run3sk-')); }

const { runRecall, _internals: recallInternals } = require('../fairy/recall');
const skillGaps  = require('../memory/skillGaps');
const project    = require('../memory/project');
const tools      = require('../fairy/tools');
const { createWorkDir } = require('../fairy/workDir');
const { _internals: fairyInternals } = require('../core/fairy');
const { FAIRY_TOOL_SPECS, EXPLORE_FAIRY_TOOL_SPECS } = require('../fairy/toolSpecs');

// ── I11: recall triage ────────────────────────────────────────────────────────

const CANDS = [
    { namespace: 'a', name: 'su2-xxx-bethe', version: '1', score: 0.46, summary: 'Bethe roots for SU(2) XXX chains via TQ.' },
    { namespace: 'b', name: 'sun-qq-system', version: '2', score: 0.44, summary: 'QQ-system solver for SU(N) XXX chains, any rank.' },
];
function mkClient() {
    return {
        search:   async () => ({ results: CANDS }),
        getSkill: async (ns, name) => ({ body: `# ${name}\n## Method\nthe method` }),
    };
}

async function runI11() {
    console.log('\n── I11: skill triage across candidates ──');
    await ok('triage overrides blind top-1 (legacy bare-index reply)', async () => {
        const res = await runRecall('spectrum of SU(3) chain', {
            client: mkClient(), llm: async () => '1', timeoutMs: 5000,
        });
        assert.strictEqual(res.mode, 'consult');
        assert.strictEqual(res.skillRef, '@b/sun-qq-system@2');
        // S1 schema: triage carries graded picks (legacy replies → one partial pick).
        assert.strictEqual(res.recallLog.triage.picks.length, 1);
        assert.strictEqual(res.recallLog.triage.picks[0].ref, '@b/sun-qq-system@2');
    });
    await ok('triage "none" → mode none (explicit gap signal)', async () => {
        const res = await runRecall('totally unrelated task', {
            client: mkClient(), llm: async () => 'none', timeoutMs: 5000,
        });
        assert.strictEqual(res.mode, 'none');
        assert.ok(/triage/.test(res.recallLog.error));
        assert.strictEqual(res.recallLog.triage.picks.length, 0);
    });
    await ok('unparseable triage injects no skill', async () => {
        const res = await runRecall('spectrum task', {
            client: mkClient(), llm: async () => 'I think maybe the second??? unclear', timeoutMs: 5000,
        });
        assert.strictEqual(res.mode, 'none');
        assert.strictEqual(res.recallLog.triageDegraded, true);
    });
    await ok('recallLog carries all candidates + scores', async () => {
        const res = await runRecall('task', { client: mkClient(), timeoutMs: 5000 });
        assert.strictEqual(res.recallLog.candidates.length, 2);
        assert.strictEqual(res.recallLog.candidates[1].ref, '@b/sun-qq-system@2');
        assert.ok(typeof res.recallLog.candidates[0].score === 'number');
    });
    await ok('_parseTriage bounds-checks the index', async () => {
        assert.strictEqual(recallInternals._parseTriage('7', 2), null);
        const t = recallInternals._parseTriage(' none — nothing fits', 2);
        assert.strictEqual(t.none, true);
        assert.deepStrictEqual(t.picks, []);
    });
}

// ── I13: skill-gap ledger ─────────────────────────────────────────────────────

async function runI13() {
    console.log('\n── I13: skill-gap ledger + remote request ──');
    // Point the project .oberon dir at a temp dir so the ledger is isolated
    // (skillGaps calls project.oberonDir(), which is null under the vscode stub).
    const root = tmpDir();
    const origOberonDir = project.oberonDir;
    project.oberonDir = () => path.join(root, '.oberon');
    try {
        let remoteCalls = 0;
        const client = { requestSkill: async () => { remoteCalls++; return { ok: true }; } };

        await ok('records locally and waits for consent', async () => {
            const r = await skillGaps.recordSkillGap({
                topic: 'nested Bethe ansatz solver for su(3) chains',
                why: 'had to derive from scratch', source: 'agent', client,
            });
            assert.strictEqual(r.recorded, true);
            assert.strictEqual(r.remote, false);
            assert.strictEqual(r.pendingConsent, true);
            assert.strictEqual(remoteCalls, 0);
            const all = await skillGaps.loadSkillGaps();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].source, 'agent');
        });
        await ok('explicit approval posts the reviewed gap remotely', async () => {
            const all = await skillGaps.loadSkillGaps();
            const r = await skillGaps.submitSkillGap(all[0], client);
            assert.strictEqual(r.submitted, true);
            assert.strictEqual(remoteCalls, 1);
        });
        await ok('near-identical topic deduped', async () => {
            const r = await skillGaps.recordSkillGap({
                topic: 'nested Bethe ansatz solver for su(3) spin chains', source: 'harness', client,
            });
            assert.strictEqual(r.recorded, false);
            assert.strictEqual(r.deduped, true);
            assert.strictEqual((await skillGaps.loadSkillGaps()).length, 1);
        });
        await ok('remote failure is swallowed (local record survives)', async () => {
            const bad = { requestSkill: async () => { throw new Error('404'); } };
            const r = await skillGaps.recordSkillGap({ topic: 'completely different topic: form factors of sinh-Gordon', client: bad });
            assert.strictEqual(r.recorded, true);
            assert.strictEqual(r.remote, false);
        });
    } finally {
        project.oberonDir = origOberonDir;
    }
}

// ── I14: skill-draft author round-trip ────────────────────────────────────────

async function runI14() {
    console.log('\n── I14: skill-draft author prompt/parse/compose ──');
    const { buildSkillAuthorPrompt, parseSkillAuthorReply, composeSkillDraftMd } = fairyInternals;

    await ok('parse accepts a good reply and slugs the name', async () => {
        const a = parseSkillAuthorReply(JSON.stringify({
            name: 'RTT Transfer-Matrix Eigenvalues!!', summary: 'Builds t(u) via RTT and verifies Λ(u).',
            method: 'Build the R-matrix, embed via swap tricks, trace out the auxiliary space, diagonalise.',
            keyResult: 'All 8 eigenvalues of t(u) for L=3.',
        }));
        assert.strictEqual(a.name, 'rtt-transfer-matrix-eigenvalues');
        assert.ok(a.method.length > 10);
    });
    await ok('parse rejects replies missing method/summary', async () => {
        assert.strictEqual(parseSkillAuthorReply('{"name":"x"}'), null);
        assert.strictEqual(parseSkillAuthorReply('not json at all'), null);
    });
    await ok('composed draft has front-matter, Method, and code fence', async () => {
        const md = composeSkillDraftMd({
            authored: { name: 'rtt-eigenvalues', summary: 'S', method: 'M', keyResult: 'K' },
            task: 'the task', definitionsLedger: 'Rmat[u_] := ...', model: 'test-model',
        });
        assert.ok(md.startsWith('---\n'));
        assert.ok(md.includes('name: rtt-eigenvalues'));
        assert.ok(md.includes('## Method'));
        assert.ok(md.includes('## Verified result'));
        assert.ok(md.includes('```wolfram'));
        assert.ok(md.includes('review before publishing'));
    });
    await ok('author prompt carries task + ledgers, capped', async () => {
        const p = buildSkillAuthorPrompt({ task: 'T'.repeat(1000), definitionsLedger: 'D'.repeat(9000), factsLedger: 'F' });
        assert.ok(p.includes('TASK SOLVED'));
        assert.ok(p.length < 8000);
    });
}

// (I17 verifyEvidenceQuick removed — the Skeptic layer was deleted; the Fairy's
// clean.wb run is now the only verification.)

// ── I19/I20: record auto-tag + note_skill_gap handler ────────────────────────

async function runI19I20() {
    console.log('\n── I19/I20: crosscheck auto-tag + note_skill_gap ──');
    const workDir = await createWorkDir(tmpDir());
    const shim = { evalOnce: async () => ({ ok: true, value: 'True' }), DEFAULT_TIMEOUT: 30 };

    await ok('record auto-tags a verification-named step', async () => {
        await workDir.saveProbe('p001', { code: 'chk = Norm[H - HH] < 1*^-10', ok: true, value: 'True' });
        const r = await tools.handleRecord({ stepId: 'verify_hermiticity', probeId: 'p001' }, { workDir, shim });
        const p = JSON.parse(r.modelPayload);
        assert.strictEqual(p.role, 'crosscheck');
        assert.strictEqual(p.autoTaggedCrosscheck, true);
        const steps = await workDir.loadValidSteps();
        assert.strictEqual(steps.find(s => s.id === 'verify_hermiticity').role, 'crosscheck');
    });
    await ok('ordinary step names are not auto-tagged', async () => {
        await workDir.saveProbe('p002', { code: 'h2 = KroneckerProduct[a, b]', ok: true, value: '{{..}}' });
        const r = await tools.handleRecord({ stepId: 'step_build_h2', probeId: 'p002' }, { workDir, shim });
        assert.strictEqual(JSON.parse(r.modelPayload).role, undefined);
    });

    await ok('note_skill_gap validates args and calls the recorder', async () => {
        let got = null;
        const ctx = { recordSkillGap: async (a) => { got = a; return { recorded: true }; } };
        const r = await tools.handleNoteSkillGap({
            topic: 'nested BAE solver for higher rank', why: 'derived the whole solver from scratch this run',
        }, ctx);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(got.source, 'agent');
        const bad = await tools.handleNoteSkillGap({ topic: 'x', why: 'y' }, ctx);
        assert.strictEqual(bad.ok, false);
    });
    await ok('note_skill_gap tolerates missing recorder (not wired)', async () => {
        const r = await tools.handleNoteSkillGap({
            topic: 'anything valid here', why: 'a genuine observed gap sentence',
        }, {});
        assert.strictEqual(r.ok, true);
        assert.strictEqual(JSON.parse(r.modelPayload).recorded, false);
    });
    await ok('note_skill_gap present in tool specs (full + explore)', async () => {
        assert.ok(FAIRY_TOOL_SPECS.some(t => t.function.name === 'note_skill_gap'));
        assert.ok(EXPLORE_FAIRY_TOOL_SPECS.some(t => t.function.name === 'note_skill_gap'));
    });
}

// ── I18: build stamp ──────────────────────────────────────────────────────────

async function runI18() {
    console.log('\n── I18: build stamp ──');
    await ok('BUILD_INFO carries version + code mtime', async () => {
        const b = fairyInternals.BUILD_INFO;
        assert.ok(b && typeof b === 'object');
        assert.ok(/^\d+\.\d+\.\d+/.test(String(b.version)), `version: ${b.version}`);
        assert.ok(!Number.isNaN(Date.parse(b.codeMtime)), `mtime: ${b.codeMtime}`);
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    await runI11();
    await runI13();
    await runI14();
    await runI19I20();
    await runI18();
    console.log(`\n── Round-3 skills: ${passCount} passed, ${failCount} failed ──`);
    process.exit(failCount ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
