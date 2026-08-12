'use strict';
/**
 * Headless unit suite for the gold-suite engine (tests/goldRunner.js).
 * No vscode, no kernel, no LLM — mocks in the director.test.js house style
 * (injected deps, scripted results, real on-disk artifacts in a tmpdir).
 *
 * Run: node out/extension/oberon/tests/goldRunner.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { EventEmitter } = require('events');

const gold  = require('./goldRunner');
const SUITE = require('./suite');

let passed = 0, failed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { passed++; console.log(`  ok  ${name}`); },
        (e) => { failed++; console.error(`FAIL  ${name}\n      ${e && e.stack || e}`); });
}

// ── suite integrity ─────────────────────────────────────────────────────────

async function suiteIntegrity() {
    await test('every task carries id/brief/contract/verifier/verify', () => {
        for (const t of SUITE) {
            for (const f of ['id', 'title', 'category', 'brief', 'contract', 'verifier', 'verify']) {
                assert.ok(t[f], `${t.id || '?'} missing ${f}`);
            }
            assert.ok(['full', 'partial', 'manual'].includes(t.verify), `${t.id} bad verify`);
            assert.ok(Array.isArray(t.contractSymbols) && t.contractSymbols.length, `${t.id} contractSymbols`);
            assert.ok(Array.isArray(t.validationChecks), `${t.id} validationChecks`);
        }
    });
    await test('ids are unique and well-formed', () => {
        const ids = SUITE.map(t => t.id);
        assert.strictEqual(new Set(ids).size, ids.length);
        for (const id of ids) assert.match(id, /^(TS|GT)\d{2}$/);
    });
    await test('verifier WL strings are quote-balanced', () => {
        for (const t of SUITE) {
            const q = (t.verifier.match(/"/g) || []).length;
            assert.strictEqual(q % 2, 0, `${t.id} has unbalanced quotes in verifier`);
        }
    });
}

// ── pure helpers ────────────────────────────────────────────────────────────

async function helpers() {
    await test('resolveTasks: all / subset / unknown', () => {
        assert.strictEqual(gold.resolveTasks(null).length, SUITE.length);
        const sub = gold.resolveTasks('gt14, ts01');
        assert.deepStrictEqual(sub.map(t => t.id), ['GT14', 'TS01']);
        assert.throws(() => gold.resolveTasks(['NOPE']), /Unknown gold task/);
    });
    await test('buildContractBrief appends the contract', () => {
        const t = SUITE.find(x => x.id === 'GT14');
        const b = gold.buildContractBrief(t);
        assert.ok(b.includes(t.brief) && b.includes('OUTPUT CONTRACT') && b.includes('goldResult'));
    });
    await test('interpretVerifierValue conventions', () => {
        assert.strictEqual(gold.interpretVerifierValue('True', 1e-6).pass, true);
        assert.strictEqual(gold.interpretVerifierValue('0', 1e-6).pass, true);
        assert.strictEqual(gold.interpretVerifierValue('1.2*^-9', 1e-6).pass, true);
        assert.strictEqual(gold.interpretVerifierValue('0.5', 1e-6).pass, false);
        assert.strictEqual(gold.interpretVerifierValue('1/3', 1e-6).pass, false);
        assert.strictEqual(gold.interpretVerifierValue('1/1000000000', 1e-6).pass, true);
        const f = gold.interpretVerifierValue('"FAIL: sector dimensions"', 1e-6);
        assert.strictEqual(f.pass, false);
        assert.ok(f.detail.startsWith('FAIL: sector'));
        assert.strictEqual(gold.interpretVerifierValue('$Failed', 1e-6).pass, false);
        // 20-digit reals with precision marks
        assert.strictEqual(gold.interpretVerifierValue('1.23`20.*^-12', 1e-6).pass, true);
    });
    await test('combineVerdict matrix', () => {
        const full = { verify: 'full' }, man = { verify: 'manual' };
        assert.strictEqual(gold.combineVerdict(full, 'delivered', { pass: true }), 'verified');
        assert.strictEqual(gold.combineVerdict(full, 'delivered', { pass: false }), 'false_delivered');
        assert.strictEqual(gold.combineVerdict(full, 'partial_delivered', { pass: true }), 'partial_verified');
        assert.strictEqual(gold.combineVerdict(full, 'partial_delivered', { pass: false }), 'partial_failed');
        assert.strictEqual(gold.combineVerdict(full, 'delivered', null), 'unverified_delivered');
        assert.strictEqual(gold.combineVerdict(full, 'failed', null), 'failed');
        assert.strictEqual(gold.combineVerdict(man, 'delivered', { pass: true }), 'sanity_passed');
    });
    await test('collectEconomics aggregates llm/tool/probe events', () => {
        const eco = gold.collectEconomics([
            { type: 'llm.call', payload: { costUSD: 0.01, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheMissTokens: 20 } } },
            { type: 'llm.call', payload: { costUSD: 0.02, usage: { inputTokens: 50, outputTokens: 5, promptCacheHitTokens: 40, promptCacheMissTokens: 10 } } },
            { type: 'tool.call', payload: {} },
            { type: 'probe.appended', payload: {} },
        ], 1234);
        assert.strictEqual(eco.llmCalls, 2);
        assert.strictEqual(eco.toolCalls, 1);
        assert.strictEqual(eco.probes, 1);
        assert.strictEqual(eco.costUSD, 0.03);
        assert.strictEqual(eco.tokens.cacheRead, 120);
        assert.strictEqual(eco.cacheHitRatio, 0.8);
        assert.strictEqual(eco.durationMs, 1234);
    });
}

// ── end-to-end with mocks ───────────────────────────────────────────────────

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gold-test-')); }

/**
 * Scripted environment: dispatchBrief synthesises a fairy run by emitting
 * telemetry on the bus and materialising a clean.wb on disk; the shim scripts
 * evalOnce replies in order [prelude, symbol-probe, verifier].
 */
function mkEnv({ status = 'delivered', verifierValue = 'True', missingSymbol = false, dispatchThrows = null } = {}) {
    const tmp = mkTmp();
    const bus = new EventEmitter();
    const evalReplies = [];
    const shim = {
        restartKernel: async () => {},
        runNotebook: async (nbPath, _opts) => {
            // signature-accurate: wolframShim.runNotebook(nbPath, opts)
            if (typeof nbPath !== 'string') throw new Error('runNotebook expects a path string');
            return { cellCount: 3, allClean: true, failures: [] };
        },
        evalOnce: async (args) => {
            // signature-accurate: wolframShim.evalOnce({ expression, timeoutSeconds })
            // (the (code, opts) misuse silently evaluated nothing in the first
            // live baseline — keep this mock strict so it can't regress)
            if (!args || typeof args !== 'object' || typeof args.expression !== 'string') {
                return { ok: false, kind: 'error', value: null, error: 'expression is empty' };
            }
            const code = args.expression;
            evalReplies.push(code);
            if (code.startsWith('WBGold`')) return { ok: true, value: '"ok"' };
            if (code.startsWith('{If[ValueQ')) return { ok: true, value: missingSymbol ? '{"goldResult"}' : '{}' };
            return { ok: true, value: verifierValue };
        },
        kernelStatus: () => ({ available: true }),
    };
    const dispatchBrief = async ({ questId }) => {
        if (dispatchThrows) throw new Error(dispatchThrows);
        const charmDir = path.join(tmp, 'quests', questId, 'charms', 'C01');
        fs.mkdirSync(charmDir, { recursive: true });
        fs.writeFileSync(path.join(charmDir, 'clean.wb'), JSON.stringify({ cells: [] }), 'utf8');
        bus.emit('event', { type: 'fairy.started', runId: 'run_test', payload: { charmDir, build: { version: 'test', codeMtime: 0 } } });
        bus.emit('event', { type: 'llm.call', runId: 'run_test', payload: { costUSD: 0.005, usage: { inputTokens: 10, outputTokens: 2 } } });
        bus.emit('event', { type: 'tool.call', runId: 'run_test', payload: {} });
        bus.emit('event', { type: 'scroll.submitted', runId: 'run_test', payload: { status, confidence: 0.9 } });
    };
    return {
        tmp, bus, shim, evalReplies,
        deps: {
            dispatchBrief, bus, shim,
            runManager: { isActive: false },
            outDir: path.join(tmp, 'gold'),
            log: () => {},
        },
    };
}

async function endToEnd() {
    await test('E1: delivered + verifier True → verified; report written', async () => {
        const env = mkEnv();
        const rep = await gold.runGoldSuite(env.deps, { taskIds: ['GT14'], label: 'unit' });
        assert.strictEqual(rep.tasks.length, 1);
        const t = rep.tasks[0];
        assert.strictEqual(t.verdict, 'verified');
        assert.strictEqual(t.status, 'delivered');
        assert.ok(t.verifier && t.verifier.pass);
        assert.strictEqual(t.economics.llmCalls, 1);
        assert.strictEqual(rep.summary.passRate, 1);
        assert.strictEqual(rep.summary.falseDelivered, 0);
        assert.ok(rep.reportPath && fs.existsSync(rep.reportPath), 'report file on disk');
        assert.ok(t.rubric && typeof t.rubric.coverage === 'number', 'process rubric attached');
        // The dispatched brief carried the contract (visible via engine internals is
        // not exposed; assert the verifier ran = 3rd scripted eval).
        assert.ok(env.evalReplies.length >= 3, 'prelude + symbol probe + verifier all ran');
    });
    await test('E2: delivered + verifier FAIL → false_delivered (the gate metric)', async () => {
        const env = mkEnv({ verifierValue: '"FAIL: expected Fibonacci[100]"' });
        const rep = await gold.runGoldSuite(env.deps, { taskIds: ['GT14'] });
        assert.strictEqual(rep.tasks[0].verdict, 'false_delivered');
        assert.strictEqual(rep.summary.falseDeliveredRate, 1);
        assert.strictEqual(rep.summary.passRate, 0);
    });
    await test('E3: missing contract symbol fails before the verifier runs', async () => {
        const env = mkEnv({ missingSymbol: true });
        const rep = await gold.runGoldSuite(env.deps, { taskIds: ['GT14'] });
        const t = rep.tasks[0];
        assert.strictEqual(t.verdict, 'false_delivered');
        assert.match(t.verifier.detail, /goldResult/);
        assert.strictEqual(env.evalReplies.length, 2, 'verifier itself must not run');
    });
    await test('E4: partial_delivered + pass → partial_verified', async () => {
        const env = mkEnv({ status: 'partial_delivered' });
        // partial runs leave clean.wb here too (mock writes clean.wb); verdict follows status
        const rep = await gold.runGoldSuite(env.deps, { taskIds: ['GT01'] });
        assert.strictEqual(rep.tasks[0].verdict, 'partial_verified');
    });
    await test('E5: dispatch error → failed, error recorded, suite continues', async () => {
        const env = mkEnv({ dispatchThrows: 'provider exploded' });
        const rep = await gold.runGoldSuite(env.deps, { taskIds: ['GT14', 'GT15'] });
        assert.strictEqual(rep.tasks.length, 2);
        for (const t of rep.tasks) {
            assert.strictEqual(t.verdict, 'failed');
            assert.match(t.error, /provider exploded/);
        }
    });
    await test('E6: kernel unavailable → throws before dispatching', async () => {
        const env = mkEnv();
        env.deps.shim.kernelStatus = () => ({ available: false, reason: 'no kernel' });
        await assert.rejects(() => gold.runGoldSuite(env.deps, { taskIds: ['GT14'] }), /kernel is not available/);
    });
    await test('E7: abort signal stops between tasks', async () => {
        const env = mkEnv();
        const ctrl = new AbortController();
        let n = 0;
        const inner = env.deps.dispatchBrief;
        env.deps.dispatchBrief = async (p) => { n++; ctrl.abort(); return inner(p); };
        const rep = await gold.runGoldSuite(env.deps, { taskIds: ['GT14', 'GT15'], signal: ctrl.signal });
        assert.strictEqual(n, 1);
        assert.strictEqual(rep.tasks.length, 1);
    });
}

// ── analytics + comparison ──────────────────────────────────────────────────

async function reporting() {
    await test('buildAnalytics: deterministic panel shape, flags false_delivered', () => {
        const a = gold.buildAnalytics([
            { id: 'GT14', verdict: 'verified', economics: { costUSD: 0.01 }, verifier: { detail: 'True' } },
            { id: 'GT15', verdict: 'false_delivered', economics: { costUSD: 0.02 }, verifier: { detail: 'FAIL: x' } },
        ]);
        assert.strictEqual(a.modelCalled, false);
        assert.strictEqual(a.parsed.overallScore, '1/2');
        assert.deepStrictEqual(a.parsed.verdicts.map(v => v.verdict), ['SUCCESS', 'FAILED']);
        assert.match(a.parsed.narrative, /FALSE-DELIVERED/);
    });
    await test('compareGoldReports: verdict + cost regressions detected', () => {
        const mk = (verdict, cost) => ({
            tasks: [{ id: 'GT14', verdict, economics: { costUSD: cost }, rubric: { score: 0.8 } }],
            summary: { passRate: verdict === 'verified' ? 1 : 0, falseDeliveredRate: 0, totalCostUSD: cost },
        });
        const reg = gold.compareGoldReports(mk('verified', 0.01), mk('false_delivered', 0.01));
        assert.strictEqual(reg.regressions.length, 1);
        const cost = gold.compareGoldReports(mk('verified', 0.01), mk('verified', 0.02));
        assert.strictEqual(cost.regressions.length, 0);
        assert.strictEqual(cost.costRegressions.length, 1);
        const ok = gold.compareGoldReports(mk('failed', 0.01), mk('verified', 0.01));
        assert.strictEqual(ok.improvements.length, 1);
        const miss = gold.compareGoldReports({ tasks: [{ id: 'GT01', verdict: 'verified', economics: {} }], summary: {} }, { tasks: [], summary: {} });
        assert.deepStrictEqual(miss.missingFromCandidate, ['GT01']);
    });
}

(async () => {
    console.log('goldRunner.test.js');
    await suiteIntegrity();
    await helpers();
    await endToEnd();
    await reporting();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
