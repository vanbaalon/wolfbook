'use strict';
/**
 * Stage 7 — R4 friction fixes + literature research
 * (FAIRY_R4_IMPLEMENTATION_PLAN_22JUN.md):
 *
 *  IV.3 — lintWolfram pre-flight (probe rejected without spending budget)
 *  IV.1 — handleDefineUtil anti-fork (util_fork / util_cap) + utilSimilarity
 *  IV.2 — FAILED_PROBE_FIX_TOOL_SPECS (amend_probe + lookup only)
 *  IV.4 — shouldAutoCheckpoint
 *  II/III — buildUtilBanner / buildStatusMarkdown / reasoningTail
 *  I    — paperSearch.extractSections, literature.runResearch, handleResearchLiterature,
 *         workDir literature round-trip, buildLiteratureCitations, research_literature spec,
 *         run_metrics new field presence
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
        workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
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
const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); passCount++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, err: e }); failCount++; }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stage7-')); }

const tools       = require('../fairy/tools');
const toolSpecs   = require('../fairy/toolSpecs');
const banners     = require('../fairy/notebookBanners');
const paperSearch = require('../../tools/paperSearch');
const literature  = require('../fairy/literature');
const cite        = require('../fairy/skillCitation');
const { _internals } = require('../core/fairy');
const { createWorkDir } = require('../fairy/workDir');

// ── IV.3 lintWolfram ──────────────────────────────────────────────────────────

async function runLint() {
    console.log('\n── IV.3: lintWolfram pre-flight ──');
    const { lintWolfram } = tools;

    await ok('balanced code passes', async () => {
        assert.strictEqual(lintWolfram('Eigenvalues[{{1,2},{3,4}}]').ok, true);
    });
    await ok('unbalanced ] is flagged', async () => {
        const r = lintWolfram('f[x_] := x] + 1');
        assert.strictEqual(r.ok, false);
        assert.ok(/bracket/i.test(r.error));
    });
    await ok('unclosed ( is flagged', async () => {
        assert.strictEqual(lintWolfram('Sin[(1 + 2').ok, false);
    });
    await ok('unterminated string is flagged', async () => {
        assert.strictEqual(lintWolfram('Print["hello]').ok, false);
    });
    await ok('brackets inside strings are ignored', async () => {
        assert.strictEqual(lintWolfram('Print["a]b)c}"]').ok, true);
    });
    await ok('brackets inside comments are ignored', async () => {
        assert.strictEqual(lintWolfram('(* a] b) *) 1 + 1').ok, true);
    });
    await ok('unterminated comment is flagged', async () => {
        assert.strictEqual(lintWolfram('1 + 1 (* never closed').ok, false);
    });

    await ok('handleProbe rejects bad syntax WITHOUT touching the kernel', async () => {
        let evalCalled = false;
        const ctx = {
            shim: { evalOnce: async () => { evalCalled = true; return { ok: true }; }, DEFAULT_TIMEOUT: 30 },
            workDir: { loadUtils: async () => [], loadAllSteps: async () => [] },
        };
        const res = await tools.handleProbe({ code: 'Sin[1 + ', note: 'broken' }, ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'syntax');
        assert.strictEqual(evalCalled, false, 'kernel must not be called for a lint failure');
    });
}

// ── R8 suppression transparency (Off[…]) + status scroll box ───────────────────

async function runSuppressionAndStatus() {
    console.log('\n── R8: Off[…] transparency + status box ──');
    const shim    = require('../core/wolframShim');
    const banners = require('../fairy/notebookBanners');
    const { buildCleanCells } = require('../fairy/workDir');

    await ok('buildSuppressionCode emits Off[…] for the soft tags, excludes General::stop', async () => {
        const code = shim.buildSuppressionCode();
        assert.ok(/Off\[FindRoot::lstol\]/.test(code));
        assert.ok(/Off\[NIntegrate::ncvb\]/.test(code));
        assert.ok(!/General::stop/.test(code), 'General::stop is not silenced');
        assert.ok(code.trim().endsWith(';'));
    });
    await ok('clean.wb gets a transparent suppression cell when suppressionCode given', async () => {
        const cells = buildCleanCells({ taskTitle: 'T', inputs: [], assumptions: [], steps: [],
            suppressionCode: 'Off[FindRoot::lstol];' });
        const text = cells.map(c => c.value).join('\n');
        assert.ok(/Suppressed non-critical warnings/.test(text));
        assert.ok(/Off\[FindRoot::lstol\]/.test(text));
    });
    await ok('clean.wb has NO suppression cell without suppressionCode (stage6 invariant holds)', async () => {
        const cells = buildCleanCells({ taskTitle: 'T', inputs: [], assumptions: [], steps: [] });
        assert.strictEqual(cells.length, 1, 'empty chain → just header');
    });

    await ok('buildStatusHtml active: header + fixed-height scroll div', async () => {
        const md = banners.buildStatusHtml({ phase: 'explore', budgetLeft: 9, thinkingTail: 'line a\nline b\nline c' });
        assert.ok(/explore/.test(md) && /9 probes left/.test(md));
        assert.ok(/max-height:140px/.test(md) && /overflow-y:auto/.test(md), 'scroll box present');
        assert.ok(/line c/.test(md));
    });
    await ok('buildStatusHtml bounds the content (last ~1800 chars)', async () => {
        const big = 'x'.repeat(5000);
        const md = banners.buildStatusHtml({ phase: 'explore', thinkingTail: big });
        assert.ok(md.length < 2200, `status html should be bounded, got ${md.length}`);
    });
    await ok('buildStatusHtml done: completion line, no scroll box', async () => {
        const md = banners.buildStatusHtml({ done: true, status: 'delivered' });
        assert.ok(/delivered/.test(md) && /✅/.test(md));
        assert.ok(!/overflow/.test(md));
    });
    await ok('buildStatusHtml escapes HTML in reasoning', async () => {
        const md = banners.buildStatusHtml({ phase: 'explore', thinkingTail: 'a < b && c > d' });
        assert.ok(/&lt;/.test(md) && /&gt;/.test(md) && /&amp;/.test(md));
    });
}

// ── R8 non-critical solver warnings no longer fail probes ──────────────────────

async function runSoftWarnings() {
    console.log('\n── R8: non-critical solver warnings ──');
    const shim = require('../core/wolframShim');

    await ok('classifyMessages: lstol soft, jsing/ivar/infy critical', async () => {
        assert.strictEqual(shim.classifyMessages('FindRoot::lstol: ...').allNonCritical, true);
        assert.strictEqual(shim.classifyMessages('NIntegrate::ncvb: ...').allNonCritical, true);
        assert.ok(shim.classifyMessages('FindRoot::jsing: singular').critical.includes('FindRoot::jsing'));
        assert.ok(shim.classifyMessages('Power::infy: 1/0').critical.includes('Power::infy'));
    });
    await ok('classifyMessages: a critical message alongside a soft one still fails', async () => {
        const c = shim.classifyMessages('FindRoot::lstol: ... Set::wrsym: protected');
        assert.strictEqual(c.allNonCritical, false);
        assert.ok(c.soft.includes('FindRoot::lstol') && c.critical.includes('Set::wrsym'));
    });

    function evalOnceCtx(wd, evalResult) {
        return {
            workDir: wd, rejectRedefinition: false,
            shim: { DEFAULT_TIMEOUT: 30, evalOnce: async () => evalResult },
        };
    }

    await ok('handleProbe KEEPS a probe with only FindRoot::lstol (ok + solverWarning)', async () => {
        const wd = await createWorkDir(tmpDir());
        const evalResult = { ok: true, value: '{0.5, -0.5}', messages: 'FindRoot::lstol: line search tolerance' };
        const res = await tools.handleProbe({ code: 'FindRoot[f[u]==0,{u,0.3}]', note: 'solve' }, evalOnceCtx(wd, evalResult));
        assert.strictEqual(res.ok, true, 'lstol does not fail the probe');
        const p = JSON.parse(res.modelPayload);
        assert.strictEqual(p.solverWarning, 'FindRoot::lstol');
        assert.ok(/verify the residual/i.test(p.notice || ''), 'notice tells agent to verify');
        assert.ok(!p.messages, 'soft warning cleared from messages');
    });
    await ok('handleProbe still FAILS a probe with FindRoot::jsing', async () => {
        const wd = await createWorkDir(tmpDir());
        const evalResult = { ok: true, value: 'x', messages: 'FindRoot::jsing: singular Jacobian' };
        const res = await tools.handleProbe({ code: 'FindRoot[...]', note: 'solve' }, evalOnceCtx(wd, evalResult));
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'messages');
    });
    await ok('a soft-warning probe is recordable (probe.ok, messages null)', async () => {
        const wd = await createWorkDir(tmpDir());
        const evalResult = { ok: true, value: '{0.5,-0.5}', messages: 'FindRoot::lstol: tol' };
        const res = await tools.handleProbe({ code: 'FindRoot[f==0,{u,0.3}]', note: 's' }, evalOnceCtx(wd, evalResult));
        const pid = res.probeId;
        const saved = await wd.getProbe(pid);
        assert.strictEqual(saved.ok, true);
        assert.ok(!saved.messages, 'no blocking messages persisted');
        assert.strictEqual(saved.softWarning, 'FindRoot::lstol');
        // record should not be blocked by has_messages
        const rec = await tools.handleRecord({ stepId: 'step_roots', probeId: pid }, { workDir: wd });
        assert.notStrictEqual(rec.kind, 'has_messages');
    });
}

// ── R7 agent-view (InputForm + shape) replaces LaTeX for the agent ─────────────

async function runAgentView() {
    console.log('\n── R7: agent-view InputForm + shape ──');

    // Stub the notebook path: getWorkingNbDoc returns a fake doc, shim.evalInNotebook
    // returns the human LaTeX value PLUS the agentValue/agentShape side channel.
    function mkCtx(wd, shimResult) {
        return {
            workDir: wd, rejectRedefinition: false,
            getWorkingNbDoc: () => ({ cellCount: 0 }),
            shim: { DEFAULT_TIMEOUT: 30, evalInNotebook: async () => shimResult },
        };
    }

    await ok('agentValue/agentShape drive resultPreview + structuralSummary (not LaTeX)', async () => {
        const wd = await createWorkDir(tmpDir());
        const shimResult = {
            ok: true, durationMs: 5,
            value: 'Out[12]= \\left\\{-3,1,1,1\\right\\}',           // human LaTeX
            agentValue: '{-3, 1, 1, 1}',                            // agent InputForm
            agentValueLen: 12,
            agentShape: 'List 4 numeric leaves=5',
        };
        const res = await tools.handleProbe({ code: 'Eigenvalues[m]', note: 'eig' }, mkCtx(wd, shimResult));
        assert.strictEqual(res.ok, true);
        const p = JSON.parse(res.modelPayload);
        assert.strictEqual(p.resultPreview, '{-3, 1, 1, 1}', 'preview is InputForm, not LaTeX');
        assert.ok(!/left|right|\\/.test(p.resultPreview), 'no LaTeX leaked to the agent');
        assert.deepStrictEqual(p.structuralSummary, { shape: 'List 4 numeric leaves=5' });
    });

    await ok('shape NON-numeric/unevaluated drives the symbolic hint', async () => {
        const wd = await createWorkDir(tmpDir());
        const shimResult = {
            ok: true, durationMs: 5,
            value: 'Out[13]= \\left\\{...big latex...\\right\\}',
            agentValue: '{{IdentityMatrix[2] \\[CircleTimes] ...}}',
            agentValueLen: 600,
            agentShape: 'List 4x4 NON-numeric(symbolic) leaves=253 unevaluated{CircleTimesx16}',
        };
        const res = await tools.handleProbe({ code: 'Eigenvalues[id2 ⊗ id2 + KroneckerProduct[a,a]]', note: 'n' }, mkCtx(wd, shimResult));
        const p = JSON.parse(res.modelPayload);
        assert.ok(/did not fully evaluate/i.test(p.hint || ''), 'symbolic hint fired from shape');
        assert.ok(/CircleTimesx16|shape:/.test(p.hint || ''), 'hint references the shape');
    });

    await ok('falls back to LaTeX value + string skeleton when no agent view', async () => {
        const wd = await createWorkDir(tmpDir());
        const shimResult = { ok: true, durationMs: 5, value: '{1, 2, 3}' };   // no agentValue
        const res = await tools.handleProbe({ code: '{1,2,3}', note: 'n' }, mkCtx(wd, shimResult));
        const p = JSON.parse(res.modelPayload);
        assert.strictEqual(p.resultPreview, '{1, 2, 3}');
        assert.strictEqual(p.structuralSummary.head, 'List', 'fell back to computeStructuralSummary');
    });

    await ok('AGENT_VIEW_SEED is ASCII-safe (embeddable in a JS string, no stray escapes)', async () => {
        const shim = require('../core/wolframShim');
        assert.ok(typeof shim.AGENT_VIEW_SEED === 'string');
        assert.ok(/WolfbookAgent`shape/.test(shim.AGENT_VIEW_SEED));
        assert.ok(/WolfbookAgent`view/.test(shim.AGENT_VIEW_SEED));
        assert.ok(!/[^\x00-\x7F]/.test(shim.AGENT_VIEW_SEED), 'seed is pure ASCII (no \\[Times] etc.)');
    });
}

// ── R6 near-duplicate probe guard + amend-on-success + symbolic hint ───────────

async function runDupGuard() {
    console.log('\n── R6: near-duplicate probe guard / amend-on-success / symbolic hint ──');
    const dupCode = 'Psu2 = (id2 + KroneckerProduct[2 sx2, 2 sx2] + KroneckerProduct[2 sy2, 2 sy2]) / 4; Eigenvalues[N[Psu2]]';

    await ok('handleProbe REJECTS a near-duplicate of a recent probe (no kernel call)', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.saveProbe('p001', { code: dupCode, ok: true, value: '{1,2}' });
        let evalCalled = false;
        const ctx = {
            workDir: wd, rejectRedefinition: false,
            shim: { evalOnce: async () => { evalCalled = true; return { ok: true, value: '1' }; }, DEFAULT_TIMEOUT: 30 },
        };
        const res = await tools.handleProbe({ code: dupCode, note: 'again', prevAnalysis: 'p001 ok' }, ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'near_duplicate');
        assert.strictEqual(evalCalled, false, 'no probe spent on a near-duplicate');
        const payload = JSON.parse(res.modelPayload);
        assert.ok(/amend_probe/.test(payload.suggestedAction) && /record/.test(payload.suggestedAction));
    });

    await ok('a genuinely different probe is NOT flagged as duplicate', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.saveProbe('p001', { code: dupCode, ok: true, value: '{1,2}' });
        const ctx = {
            workDir: wd, rejectRedefinition: false,
            shim: { evalOnce: async () => ({ ok: true, value: '7' }), DEFAULT_TIMEOUT: 30 },
        };
        const res = await tools.handleProbe({ code: 'Integrate[Sin[x]^2, {x, 0, Pi}]', note: 'n', prevAnalysis: 'p001 ok' }, ctx);
        assert.notStrictEqual(res.kind, 'near_duplicate');
        assert.strictEqual(res.ok, true);
    });

    await ok('amend_probe BYPASSES the duplicate guard (it is meant to resemble)', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.saveProbe('p001', { code: dupCode, ok: true, value: '{1,2}' });
        const ctx = {
            workDir: wd, rejectRedefinition: false, amendProbeId: 'p001',
            shim: { evalOnce: async () => ({ ok: true, value: '9' }), DEFAULT_TIMEOUT: 30 },
        };
        const res = await tools.handleProbe({ code: dupCode, note: 'refine' }, ctx);
        assert.notStrictEqual(res.kind, 'near_duplicate');
        assert.strictEqual(res.ok, true);
    });

    await ok('amend_probe now works after a SUCCESSFUL probe (refine in place)', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.saveProbe('p001', { code: 'x', ok: true, value: 'symbolic' });
        const ctx = {
            lastProbeId: 'p001', lastProbeFailed: false, workDir: wd, rejectRedefinition: false,
            shim: { evalOnce: async () => ({ ok: true, value: '42.0' }), DEFAULT_TIMEOUT: 30 },
        };
        const res = await tools.handleAmendProbe({ code: 'N[result]', note: 'force numeric' }, ctx);
        assert.strictEqual(res.ok, true, 'amend on a successful probe is allowed');
        assert.strictEqual(res.amended, true);
    });

    await ok('amend_probe still errors when there is no prior probe', async () => {
        const res = await tools.handleAmendProbe({ code: 'x' }, { lastProbeId: null, workDir: {} });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'nothing_to_amend');
    });

    await ok('CircleTimes/symbolic HINT fires on a big unevaluated result', async () => {
        const wd = await createWorkDir(tmpDir());
        const bigSym = '\\left\\{' + '\\mathrm{Root}\\otimes '.repeat(150) + '\\right\\}';
        const ctx = {
            workDir: wd, rejectRedefinition: false,
            shim: { evalOnce: async () => ({ ok: true, value: bigSym }), DEFAULT_TIMEOUT: 30 },
        };
        const res = await tools.handleProbe({ code: 'Eigenvalues[id2⊗id2 + KroneckerProduct[a, a]]', note: 'n' }, ctx);
        assert.strictEqual(res.ok, true);
        const payload = JSON.parse(res.modelPayload);
        assert.ok(/KroneckerProduct/.test(payload.hint), 'CircleTimes footgun hint');
        assert.ok(/UNEVALUATED/i.test(payload.hint), 'large-symbolic-output hint');
    });
}

// ── IV.1 anti-fork define_util ─────────────────────────────────────────────────

async function runAntiFork() {
    console.log('\n── IV.1: define_util anti-fork ──');
    const { utilSimilarity, handleDefineUtil } = tools;

    await ok('utilSimilarity: identical code → 1', async () => {
        assert.strictEqual(utilSimilarity('f[x_]:=x+1', 'f[x_]:=x+1'), 1);
    });
    await ok('utilSimilarity: disjoint code → low', async () => {
        assert.ok(utilSimilarity('foo[a_]:=a^2', 'bar[z_]:=Sin[z]') < 0.3);
    });
    await ok('utilSimilarity: near-duplicate (renamed) → high', async () => {
        const a = 'solver[L_]:=Module[{m},m=Range[L];Total[m^2]]';
        const b = 'solver2[L_]:=Module[{m},m=Range[L];Total[m^2]]';
        assert.ok(utilSimilarity(a, b) >= 0.6, `sim=${utilSimilarity(a, b)}`);
    });

    const body = 'tqSolve[L_, M_] := Module[{eqs}, eqs = Range[L]; Solve[eqs == M]]';
    await ok('define_util rejects a near-duplicate under a NEW name (util_fork)', async () => {
        const ctx = {
            shim: { evalOnce: async () => ({ ok: true }), DEFAULT_TIMEOUT: 30 },
            workDir: { loadUtils: async () => [{ name: 'tqSolve', code: body, note: 'orig' }] },
        };
        const res = await tools.handleDefineUtil(
            { name: 'tqSolveFinal', code: body.replace('tqSolve', 'tqSolveFinal'), note: 'same thing renamed' }, ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'util_fork');
        assert.ok(/tqSolve/.test(res.error), 'names the existing util');
    });
    await ok('define_util ALLOWS redefining the SAME name', async () => {
        let added = null;
        const ctx = {
            shim: { evalOnce: async () => ({ ok: true, messages: [] }), DEFAULT_TIMEOUT: 30 },
            signal: null,
            workDir: { loadUtils: async () => [{ name: 'tqSolve', code: body, note: 'orig' }],
                addUtil: async (u) => { added = u; } },
        };
        const res = await tools.handleDefineUtil({ name: 'tqSolve', code: body + ' (* tweak *)', note: 'fix' }, ctx);
        assert.strictEqual(res.ok, true);
        assert.ok(added && added.name === 'tqSolve');
    });
    await ok('define_util rejects new util past the cap (util_cap)', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ name: `u${i}`, code: `u${i}[x_]:=x+${i}`, note: 'n' }));
        const ctx = {
            shim: { evalOnce: async () => ({ ok: true }), DEFAULT_TIMEOUT: 30 },
            workDir: { loadUtils: async () => many },
        };
        const res = await tools.handleDefineUtil({ name: 'brandNew', code: 'brandNew[x_]:=x', note: 'n' }, ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'util_cap');
    });
}

// ── IV.2 failed-probe-fix tool set ─────────────────────────────────────────────

async function runFailedProbeFix() {
    console.log('\n── IV.2: FAILED_PROBE_FIX_TOOL_SPECS ──');
    await ok('exports exactly amend_probe + lookup', async () => {
        const specs = toolSpecs.FAILED_PROBE_FIX_TOOL_SPECS;
        assert.ok(Array.isArray(specs));
        const names = specs.map(t => t.function.name).sort();
        assert.deepStrictEqual(names, ['amend_probe', 'lookup']);
    });
    await ok('does NOT include a fresh probe or record', async () => {
        const names = toolSpecs.FAILED_PROBE_FIX_TOOL_SPECS.map(t => t.function.name);
        assert.ok(!names.includes('probe'));
        assert.ok(!names.includes('record'));
    });
    await ok('R10: RECORD_GATE_TOOL_SPECS = record/note_fact/chain/invalidate, no probe', async () => {
        const names = toolSpecs.RECORD_GATE_TOOL_SPECS.map(t => t.function.name).sort();
        assert.deepStrictEqual(names, ['chain', 'invalidate', 'note_fact', 'record']);
        assert.ok(!names.includes('probe'), 'probing is paused during a record gate');
    });
    await ok('R11: FairyFSM.grantMoreBudget extends probe/turn caps without losing state', async () => {
        const { FairyFSM } = require('../fairy/fsm');
        const fsm = new FairyFSM();
        fsm.transitionTo('explore');
        const probes0 = fsm.exploreProbesRemaining, turns0 = fsm.turnsRemaining;
        fsm.incrementTurn(); try { fsm.consumeProbe(); } catch (_) {}
        fsm.grantMoreBudget({ probes: 15, turns: 25 });
        assert.ok(fsm.exploreProbesRemaining > probes0 - 1, 'probe budget extended');
        assert.ok(fsm.turnsRemaining > turns0 - 1, 'turn budget extended');
        assert.strictEqual(fsm.turnsUsed, 1, 'used counters preserved (state not reset)');
    });
    await ok('R12: grantMoreBudget also extends polish budget', async () => {
        const { FairyFSM } = require('../fairy/fsm');
        const fsm = new FairyFSM();
        const p0 = fsm.polishTurnsRemaining, r0 = fsm.polishRunCleansRemaining;
        fsm.grantMoreBudget({ polishTurns: 6, polishRunCleans: 3 });
        assert.strictEqual(fsm.polishTurnsRemaining, p0 + 6, 'polish turns extended');
        assert.strictEqual(fsm.polishRunCleansRemaining, r0 + 3, 'run_clean budget extended');
    });
    await ok('R12: POLISH set excludes invalidate (which deletes clean.wb)', async () => {
        const names = toolSpecs.POLISH_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(!names.includes('invalidate'), 'invalidate must not be a polish tool');
        assert.ok(names.includes('edit_cell') && names.includes('run_clean'), 'polish has the fix tools');
    });
}

// ── IV.4 auto-checkpoint ───────────────────────────────────────────────────────

async function runAutoCheckpoint() {
    console.log('\n── IV.4: shouldAutoCheckpoint ──');
    const { shouldAutoCheckpoint } = _internals;
    await ok('fires every 3rd record', async () => {
        assert.strictEqual(shouldAutoCheckpoint(3, 3), true);
        assert.strictEqual(shouldAutoCheckpoint(6, 3), true);
    });
    await ok('does not fire off-cadence or at zero', async () => {
        assert.strictEqual(shouldAutoCheckpoint(0, 3), false);
        assert.strictEqual(shouldAutoCheckpoint(1, 3), false);
        assert.strictEqual(shouldAutoCheckpoint(2, 3), false);
        assert.strictEqual(shouldAutoCheckpoint(4, 3), false);
    });
}

// ── II/III notebook banners ────────────────────────────────────────────────────

async function runBanners() {
    console.log('\n── II/III: util banner + status cell ──');
    await ok('buildUtilBanner shows name + note', async () => {
        const md = banners.buildUtilBanner({ name: 'betheEqs', note: 'Bethe equations' });
        assert.ok(md.includes('betheEqs') && md.includes('Bethe equations'));
        assert.ok(md.startsWith('###'));
    });
    await ok('buildStatusMarkdown active: phase + budget + thinking', async () => {
        const md = banners.buildStatusMarkdown({ phase: 'explore', budgetLeft: 12, thinkingTail: 'line a\nline b' });
        assert.ok(md.includes('explore'));
        assert.ok(md.includes('12 probes left'));
        assert.ok(md.includes('line b'));
        assert.ok(md.startsWith('>'), 'blockquote chrome');
    });
    await ok('buildStatusMarkdown terminal: glyph + status', async () => {
        const md = banners.buildStatusMarkdown({ done: true, status: 'delivered' });
        assert.ok(md.includes('delivered'));
        assert.ok(md.includes('✅'));
    });
    await ok('reasoningTail keeps last n non-empty lines', async () => {
        assert.strictEqual(banners.reasoningTail('a\n\nb\nc\nd', 2), 'c\nd');
    });
}

// ── I.a paperSearch.extractSections ────────────────────────────────────────────

async function runExtract() {
    console.log('\n── I: paperSearch.extractSections ──');
    await ok('extractSections pulls headings + LaTeX from alttext', async () => {
        const html = `
            <html><head><style>.x{}</style><script>var z=1;</script></head>
            <body>
              <h2>Bethe Ansatz</h2>
              <p>The equation <math alttext="E = \\sum_j \\epsilon_j">E</math> holds.</p>
              <h3>Results</h3>
            </body></html>`;
        const out = paperSearch.extractSections(html);
        assert.ok(Array.isArray(out.headings) && out.headings.some(h => /Bethe Ansatz/.test(h)));
        assert.ok(out.equations.some(e => /\\sum_j/.test(e)), `eqs: ${JSON.stringify(out.equations)}`);
        assert.ok(typeof out.textSample === 'string');
    });
    await ok('extractSections pulls LaTeX from arXiv-native <annotation … x-tex>', async () => {
        const html = '<body><math><annotation encoding="application/x-tex">\\zeta(s)=\\sum n^{-s}</annotation></math></body>';
        const out = paperSearch.extractSections(html);
        assert.ok(out.equations.some(e => /\\zeta\(s\)/.test(e)), `eqs: ${JSON.stringify(out.equations)}`);
    });
    await ok('extractSections tolerates empty/garbage input', async () => {
        const out = paperSearch.extractSections('');
        assert.deepStrictEqual(out.headings, []);
        assert.deepStrictEqual(out.equations, []);
    });
    await ok('fetchPaperHtml flags abstract-only fetch (no full text)', async () => {
        // We can't hit the network in tests; assert the function exists and is async.
        assert.strictEqual(typeof paperSearch.fetchPaperHtml, 'function');
    });
}

// ── I.b literature.runResearch (fakes, no network) ─────────────────────────────

// On-topic + off-topic candidates. searchArxiv is the primary backend now.
function fakeArxivPapers() {
    return [
        { title: 'SU(3) Bethe ansatz chain', abstract: 'bethe ansatz su3 heisenberg transfer matrix', arxivId: '2401.00001', year: 2024, authors: ['A. One'], doi: '10.1/x', inspireId: '111', texkey: 'One:2024' },
        { title: 'Nested Bethe equations for su3 spin chains', abstract: 'su3 bethe nested heisenberg', arxivId: '2401.00003', year: 2022, authors: ['C. Three'] },
        { title: 'Observation of rare B meson decay', abstract: 'lhcb ckm branching ratio cosmology', arxivId: '2401.00002', year: 2023, authors: ['B. Two'] }, // OFF-TOPIC
    ];
}
function fakePaperTools(opts = {}) {
    const papers = opts.papers || fakeArxivPapers();
    return {
        searchArxiv: async () => papers,
        searchInspire: async () => [],
        searchPapers: async () => ({ source: 'INSPIRE-HEP', papers }),
        // New contract: { html, source, hasFullText }. Padded to look like full text.
        fetchPaperHtml: async (id) => ({
            html: '<html><body>' + '<p>bethe ansatz su3 transfer matrix</p>'.repeat(20) + '<math alttext="x=1">x</math></body></html>',
            source: 'ar5iv', hasFullText: true,
        }),
        extractSections: () => ({ headings: ['H'], equations: ['x=1'], textSample: 'text about su3 bethe' }),
    };
}

// A judge LLM that: plans, preselects on-topic indices from abstracts, and on a full
// read marks on-topic su3/bethe papers relevant and rejects the rest.
function fakeJudgeLlm() {
    return async (prompt) => {
        if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"su3 bethe nested","categories":["hep-th"]}';
        if (/pick up to/i.test(prompt) && /indices/i.test(prompt)) {
            // PRESELECT: choose the two on-topic papers (0,1), drop the off-topic one (2).
            return '0,1';
        }
        // READ prompt → judge by paper title/body text inside it.
        const head = prompt.split('Body excerpt')[0] || prompt;
        const onTopic = /su\(?3\)?|bethe/i.test(head) && !/neutron|ckm|lhcb|b meson/i.test(head);
        return onTopic
            ? '{"relevant": true, "reason": "studies the SU(3) Bethe ansatz", "key_relations": [{"statement":"energy sum","latex":"E=sum"}], "observations": ["nested structure"]}'
            : '{"relevant": false, "reason": "different physical system", "key_relations": [], "observations": []}';
    };
}

async function runLiteratureAgent() {
    console.log('\n── I: literature.runResearch (read → judge → extract) ──');
    const Q = 'su3 bethe ansatz heisenberg chain energy';
    await ok('returns empty brief when no question', async () => {
        const b = await literature.runResearch({ question: '', paperTools: fakePaperTools() });
        assert.deepStrictEqual(b.papers, []);
    });
    await ok('returns empty brief when no tools', async () => {
        const b = await literature.runResearch({ question: 'q?', paperTools: null });
        assert.deepStrictEqual(b.papers, []);
    });
    await ok('no-LLM fallback: token-judge keeps on-topic, returns relations + diagnostics', async () => {
        const b = await literature.runResearch({ question: Q, paperTools: fakePaperTools() });
        assert.ok(b.papers.length >= 1);
        assert.ok(b.papers.every(p => p.relevant === true), 'papers are marked relevant');
        assert.ok(b.key_equations.length >= 1 && b.key_equations.every(e => /VERIFY/i.test(e.caveat)), 'relations flagged unverified');
        assert.ok(b.diagnostics && b.diagnostics.read >= 1 && b.diagnostics.relevant >= 1, 'read/relevant tracked');
    });
    await ok('preselect drops off-topic paper before full read; relevant ones returned', async () => {
        const b = await literature.runResearch({ question: Q, paperTools: fakePaperTools(), llm: fakeJudgeLlm() });
        const refs = b.papers.map(p => p.arxivId);
        assert.ok(!refs.includes('2401.00002'), 'off-topic B-meson paper excluded');
        assert.ok(b.papers.length >= 1 && b.papers.every(p => p.relevant), 'only relevant returned');
        assert.ok(b.key_equations.some(e => /E=/.test(e.latex)), 'extracted relation from judge');
        assert.ok(b.observations.length >= 1, 'observations extracted');
    });
    await ok('read-judge still rejects a paper that slipped through preselect', async () => {
        // preselect picks ALL three (incl. off-topic); the full read must reject the off-topic one.
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"su3 bethe","categories":["hep-th"]}';
            if (/pick up to/i.test(prompt)) return '0,1,2';
            const head = prompt.split('Body excerpt')[0] || prompt;
            return /b meson|ckm|lhcb/i.test(head)
                ? '{"relevant": false, "reason": "B-meson physics, not spin chains", "key_relations": [], "observations": []}'
                : '{"relevant": true, "reason": "ok", "key_relations": [{"latex":"E=1"}], "observations": []}';
        };
        const b = await literature.runResearch({ question: Q, paperTools: fakePaperTools(), llm });
        assert.ok(!b.papers.map(p => p.arxivId).includes('2401.00002'), 'off-topic rejected at read');
        assert.ok(b.considered.some(c => c.relevant === false), 'rejection recorded in considered[]');
    });
    await ok('FAIL-OPEN (Phase 2 #5): unparseable judge → retried, then kept as UNCERTAIN (not dropped, not relevant)', async () => {
        let judgeCalls = 0;
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"su3 bethe","categories":["hep-th"]}';
            if (/pick up to/i.test(prompt)) return '0';
            judgeCalls++;   // read prompt + the strict retry both land here
            return 'I think this paper is somewhat related, hard to say';   // unparseable, twice
        };
        const b = await literature.runResearch({ question: Q, paperTools: fakePaperTools(), llm });
        assert.deepStrictEqual(b.papers, [], 'still no false-positive: uncertain is NOT promoted to relevant');
        assert.ok(judgeCalls >= 2, `judge must be retried once (got ${judgeCalls} calls)`);
        assert.strictEqual((b.uncertain || []).length, 1, 'the unjudged paper is kept as uncertain, not silently dropped');
        assert.ok(b.considered.some(c => c.relevant === 'uncertain' && /unparseable/i.test(c.reason || '')), 'considered records the uncertain verdict + reason');
    });
    await ok('preselect "none" → honest empty brief without any full read', async () => {
        let reads = 0;
        const pt = fakePaperTools();
        const origFetch = pt.fetchPaperHtml;
        pt.fetchPaperHtml = async (id) => { reads++; return origFetch(id); };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"su3","categories":["hep-th"]}';
            if (/pick up to/i.test(prompt)) return 'none';
            return '{"relevant":true}';
        };
        const b = await literature.runResearch({ question: Q, paperTools: pt, llm });
        assert.deepStrictEqual(b.papers, []);
        assert.strictEqual(reads, 0, 'no full reads when preselect says none');
    });
    await ok('honest empty brief when ALL papers judged irrelevant', async () => {
        const offTopic = [{ title: 'Slowly rotating neutron stars in chiral SU(3)', abstract: 'neutron stars hadronic', arxivId: '9.9', year: 2009, authors: [] }];
        const llm = async (prompt) => /SEARCH PLAN/.test(prompt)
            ? '{"keywords":"su3 bethe","categories":["hep-th"]}'
            : '{"relevant": false, "reason": "about neutron stars, not spin chains", "key_relations": [], "observations": []}';
        const b = await literature.runResearch({ question: Q, paperTools: fakePaperTools({ papers: offTopic }), llm });
        assert.deepStrictEqual(b.papers, []);
        assert.ok(/no relevant/i.test(b.note || ''), 'note explains nothing relevant');
        assert.ok(b.considered.length >= 1, 'still records what it read');
    });
    await ok('plan keywords from the LLM are used', async () => {
        const b = await literature.runResearch({ question: Q, paperTools: fakePaperTools(), llm: fakeJudgeLlm() });
        assert.strictEqual(b.plan.keywords, 'su3 bethe nested');
    });
    await ok('fails open when search throws', async () => {
        const pt = { searchArxiv: async () => { throw new Error('boom'); } };
        const b = await literature.runResearch({ question: Q, paperTools: pt });
        assert.deepStrictEqual(b.papers, []);
    });
    await ok('_normalizeFetch handles both object and legacy-string returns', async () => {
        const obj = await literature._internals._normalizeFetch({ fetchPaperHtml: async () => ({ html: 'x'.repeat(300), source: 'ar5iv', hasFullText: true }) }, 'id');
        assert.strictEqual(obj.hasFullText, true);
        const str = await literature._internals._normalizeFetch({ fetchPaperHtml: async () => 'x'.repeat(300) }, 'id');
        assert.strictEqual(str.hasFullText, true);
    });
    await ok('_parseJudge parses a relevance verdict', async () => {
        const j = literature._internals._parseJudge('{"relevant":true,"reason":"r","key_relations":[{"statement":"s","latex":"l"}],"observations":["o"]}');
        assert.strictEqual(j.relevant, true);
        assert.strictEqual(j.key_relations[0].latex, 'l');
    });
}

// ── I.c handleResearchLiterature ───────────────────────────────────────────────

async function runResearchTool() {
    console.log('\n── I: handleResearchLiterature ──');
    await ok('unavailable without paperTools', async () => {
        const res = await tools.handleResearchLiterature({ question: 'su3 bethe equations' }, { workDir: {} });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'unavailable');
    });
    await ok('persists a brief and returns a condensed, UNVERIFIED-flagged payload', async () => {
        const wd = await createWorkDir(tmpDir());
        const ctx = { paperTools: fakePaperTools(), literatureLlm: null, workDir: wd };
        const res = await tools.handleResearchLiterature({ question: 'su3 bethe equations' }, ctx);
        assert.strictEqual(res.ok, true);
        const payload = JSON.parse(res.modelPayload);
        assert.ok(payload.papers.length >= 1);
        assert.ok(/UNVERIFIED/i.test(payload.reminder), 'reminder warns unverified');
        const briefs = await wd.loadLiteratureBriefs();
        assert.strictEqual(briefs.length, 1, 'brief persisted');
        assert.strictEqual(briefs[0].question, 'su3 bethe equations');
    });
    await ok('bad_args on a too-short question', async () => {
        const res = await tools.handleResearchLiterature({ question: 'hi' }, { paperTools: fakePaperTools(), workDir: {} });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'bad_args');
    });
    await ok('rejects a near-duplicate question (duplicate_query)', async () => {
        const wd = await createWorkDir(tmpDir());
        const ctx = { paperTools: fakePaperTools(), literatureLlm: null, workDir: wd };
        await tools.handleResearchLiterature({ question: 'su3 bethe ansatz heisenberg energy formula' }, ctx);
        const res = await tools.handleResearchLiterature({ question: 'su3 bethe ansatz heisenberg energy formula please' }, ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'duplicate_query');
    });
    await ok('hard-caps literature searches per run (budget_spent)', async () => {
        const wd = await createWorkDir(tmpDir());
        const ctx = { paperTools: fakePaperTools(), literatureLlm: null, workDir: wd };
        // 3 distinct on-topic questions fill the cap.
        await tools.handleResearchLiterature({ question: 'su3 bethe ansatz energy formula' }, ctx);
        await tools.handleResearchLiterature({ question: 'baxter tq relation transfer matrix eigenvalue' }, ctx);
        await tools.handleResearchLiterature({ question: 'nested algebraic bethe yangian rapidity roots' }, ctx);
        const res = await tools.handleResearchLiterature({ question: 'completely different fourth topic about magnons' }, ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.kind, 'budget_spent');
    });
}

// ── I.d workDir literature round-trip ──────────────────────────────────────────

async function runWorkDirLit() {
    console.log('\n── I: workDir literature round-trip ──');
    await ok('addLiteratureBrief + loadLiteratureBriefs round-trips and dedupes by question', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.addLiteratureBrief({ question: 'Q1', papers: [{ ref: 'arXiv:1' }] });
        await wd.addLiteratureBrief({ question: 'Q2', papers: [{ ref: 'arXiv:2' }] });
        await wd.addLiteratureBrief({ question: 'Q1', papers: [{ ref: 'arXiv:1b' }] }); // overwrite Q1
        const all = await wd.loadLiteratureBriefs();
        assert.strictEqual(all.length, 2);
        const q1 = all.find(b => b.question === 'Q1');
        assert.strictEqual(q1.papers[0].ref, 'arXiv:1b', 'Q1 overwritten');
    });
    await ok('loadLiteratureBriefs returns [] when file is absent', async () => {
        const wd = await createWorkDir(tmpDir());
        assert.deepStrictEqual(await wd.loadLiteratureBriefs(), []);
    });
}

// ── I.e buildLiteratureCitations ───────────────────────────────────────────────

async function runLitCitations() {
    console.log('\n── I: buildLiteratureCitations ──');
    await ok('builds a list + bibtex, deduped across briefs', async () => {
        const briefs = [
            { question: 'Q1', papers: [{ title: 'Paper A', authors: ['X. Y'], year: 2024, arxivId: '2401.1', texkey: 'XY:2024', ref: 'arXiv:2401.1' }] },
            { question: 'Q2', papers: [{ title: 'Paper A', authors: ['X. Y'], year: 2024, arxivId: '2401.1', ref: 'arXiv:2401.1' }] }, // dup
        ];
        const md = cite.buildLiteratureCitations(briefs);
        assert.ok(md.includes('## Literature consulted'));
        assert.ok(md.includes('Paper A'));
        assert.ok(md.includes('arXiv:2401.1'));
        assert.ok(md.includes('```bibtex') && md.includes('@article{XY_2024'));
        // dedupe: "Paper A" appears once in the list (plus once in bibtex title)
        const listOccurrences = (md.split('\n').filter(l => l.startsWith('- ') && l.includes('Paper A'))).length;
        assert.strictEqual(listOccurrences, 1, 'paper listed once');
    });
    await ok('empty for no papers', async () => {
        assert.strictEqual(cite.buildLiteratureCitations([]), '');
        assert.strictEqual(cite.buildLiteratureCitations([{ question: 'Q', papers: [] }]), '');
    });

    console.log('\n── I: buildLiteratureBriefMarkdown (live summary cell) ──');
    await ok('summary cell shows papers, relations, observations, rejected', async () => {
        const brief = {
            question: 'SU(3) QQ-system',
            diagnostics: { searched: 12, read: 4, fullText: 3, relevant: 1 },
            papers: [{ title: 'Q-system paper', ref: 'arXiv:1', year: 2020, fullText: true, reason: 'derives the SU(3) QQ-system' }],
            key_equations: [{ statement: 'QQ relation', latex: 'Q1 Q2 = ...', source: 'arXiv:1', caveat: 'x' }],
            observations: [{ text: 'roots are real', source: 'arXiv:1' }],
            considered: [{ ref: 'arXiv:9', title: 'SU(2) chain', relevant: false, reason: 'SU(2), not SU(3)' }],
        };
        const md = cite.buildLiteratureBriefMarkdown(brief);
        assert.ok(/## 📚 Literature: SU\(3\) QQ-system/.test(md));
        assert.ok(/1 relevant/.test(md) && /Q-system paper/.test(md) && /derives the SU\(3\)/.test(md));
        assert.ok(/Key relations/.test(md) && /UNVERIFIED/.test(md) && /Q1 Q2/.test(md));
        assert.ok(/Observations/.test(md) && /roots are real/.test(md));
        assert.ok(/Read & rejected/.test(md) && /SU\(2\), not SU\(3\)/.test(md));
    });
    await ok('summary cell handles 0 relevant gracefully', async () => {
        const md = cite.buildLiteratureBriefMarkdown({ question: 'Q', note: 'no relevant papers', papers: [],
            diagnostics: { searched: 12, read: 6, fullText: 6, relevant: 0 }, considered: [] });
        assert.ok(/0 relevant/.test(md) && /no relevant papers/.test(md));
    });
    await ok('summary cell empty for no brief', async () => {
        assert.strictEqual(cite.buildLiteratureBriefMarkdown(null), '');
    });
}

// ── I.f spec + metrics wiring ──────────────────────────────────────────────────

async function runSpecPresence() {
    console.log('\n── I: research_literature spec presence ──');
    await ok('research_literature is in the full + explore specs', async () => {
        const full = toolSpecs.FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(full.includes('research_literature'), 'in FAIRY_TOOL_SPECS');
        const explore = toolSpecs.EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(explore.includes('research_literature'), 'in EXPLORE_FAIRY_TOOL_SPECS');
    });
    await ok('research_literature requires a question and is free', async () => {
        const spec = toolSpecs.FAIRY_TOOL_SPECS.find(t => t.function.name === 'research_literature');
        assert.deepStrictEqual(spec.function.parameters.required, ['question']);
        assert.ok(/FREE/.test(spec.function.description));
        assert.ok(/UNVERIFIED/.test(spec.function.description));
    });
    await ok('handler is registered (dispatch knows research_literature)', async () => {
        const res = await tools.dispatchFairyTool({ name: 'research_literature', args: { question: 'x' } }, { workDir: {} });
        // no paperTools wired → unavailable, NOT unknown_tool
        assert.notStrictEqual(res.kind, 'unknown_tool');
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    for (const s of [
        runLint, runSuppressionAndStatus, runSoftWarnings, runAgentView, runDupGuard, runAntiFork, runFailedProbeFix, runAutoCheckpoint, runBanners,
        runExtract, runLiteratureAgent, runResearchTool, runWorkDirLit, runLitCitations, runSpecPresence,
    ]) await s();
    console.log(`\n── Stage 7 Results: ${passCount} passed, ${failCount} failed ──`);
    if (failures.length) {
        for (const { label, err } of failures) {
            console.error(`  [FAIL] ${label}`);
            if (err && err.stack) console.error('    ' + err.stack.split('\n').join('\n    '));
        }
        process.exit(1);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
