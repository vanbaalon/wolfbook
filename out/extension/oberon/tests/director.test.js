'use strict';
/**
 * Oberon Director — headless test suite (mock LLM + mock fairy, no vscode).
 *
 * Covers the full programme loop:
 *   D1  happy path: plan → 2 delivered stages → synthesis → contribution → report
 *   D2  partial delivery → consult_literature → informed revise_stage retry
 *   D3  early stop_success skips remaining stages without downgrading outcome
 *   D4  every post-plan LLM call fails → deterministic fallbacks still deliver a report
 *   D5  abort mid-programme → status 'aborted' persisted
 *   D6  resume: completed stages are not re-run; key results survive
 *   P*  parser units, A* analyst digests, R* report assembly, S* state store
 *
 * Run: node out/extension/oberon/tests/director.test.js
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
        workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }), notebookDocuments: [], workspaceFolders: [] },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
        EventEmitter: class { constructor() { this.event = () => {}; } on() {} off() {} fire() {} },
        Uri: { file: (p) => ({ fsPath: p }) },
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
    catch (e) { console.error(`  FAIL ${label}: ${e && e.stack || e}`); failCount++; }
}

const state    = require('../director/state');
const prompts  = require('../director/prompts');
const analyst  = require('../director/analyst');
const report   = require('../director/report');
const { runDirector, _internals } = require('../director/director');

// ── fixtures / helpers ───────────────────────────────────────────────────────

function freshRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'oberon-director-'));
}

function makeBus() {
    const events = [];
    return {
        runId: 'run_test', events,
        appendEvent: async (type, payload) => { events.push({ type, payload }); },
        on() {}, removeListener() {},
    };
}

function makeCharmDir(root, facts) {
    const dir = fs.mkdtempSync(path.join(root, 'charm-'));
    if (facts) fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(facts, null, 2));
    return dir;
}

function makeCleanNb(dir, cells) {
    const p = path.join(dir, 'clean.wb');
    fs.writeFileSync(p, JSON.stringify({ cells, metadata: {} }, null, 1));
    return p;
}

function scrollOf({ status = 'delivered', findings = ['E0 = -4.5 for the L=4 XXX chain, matches exact diagonalization to 12 digits'], confidence = 0.9, charmDir = null, openQuestions = [] } = {}) {
    return {
        id: 'S01', questId: 'Q99', charmId: 'C01', summary: 'stage summary',
        findings, openQuestions, confidence, selfChecks: [], evidence: [],
        fairyArtifact: { status, charmDir },
    };
}

function deliveredStageResult(root, { questId = 'Q90', findings, handoff = null } = {}) {
    const charmDir = makeCharmDir(root, [{ key: 'E0_L4', value: '-4.5', confidence: 0.95 }]);
    const cleanNbPath = makeCleanNb(charmDir, [
        { kind: 1, languageId: 'markdown', value: '# header', outputs: [], metadata: {} },
        { kind: 2, languageId: 'wolfram', value: 'H = HamXXX[4];\nE0 = Min[Eigenvalues[H]]', outputs: [{ items: [{ mime: 'text/plain', data: '-4.5' }] }], metadata: {} },
    ]);
    return {
        questId, charmDir, cleanNbPath, partialNbPath: null,
        scroll: scrollOf({ status: 'delivered', findings, charmDir }),
        handoff: handoff || { utils: [{ name: 'HamXXX', code: 'HamXXX[L_] := …' }], facts: [] },
    };
}

function makeRunStage(script) {
    const calls = [];
    const fn = async (args) => {
        calls.push({ stageId: args.stage.id, task: args.task, handoff: args.handoff });
        const r = typeof script === 'function' ? script(args, calls.length - 1)
                : script[Math.min(calls.length - 1, script.length - 1)];
        if (r instanceof Error) throw r;
        return r;
    };
    fn.calls = calls;
    return fn;
}

function makeLlm(handler) {
    const calls = [];
    const fn = async ({ messages, purpose }) => {
        calls.push({ purpose, messages });
        const content = await handler(purpose, messages, calls.length - 1);
        return { content, usage: { inputTokens: 10, outputTokens: 10 }, costUSD: 0.001, provider: 'mock', model: 'mock', latencyMs: 1, stopReason: 'end' };
    };
    fn.calls = calls;
    return fn;
}

const PLAN_2STAGE = JSON.stringify({
    title: 'XXX chain spectrum programme',
    shortName: 'xxx_chain',
    objective: 'Compute and verify the XXX spin-chain spectrum at L=4, then extend to L=6.',
    finalDeliverable: 'Verified ground-state energies for L=4 and L=6 with cross-checks.',
    missingInfo: [],
    stages: [
        {
            title: 'L=4 spectrum with exact-diagonalization check',
            task: 'Construct the L=4 XXX Heisenberg Hamiltonian with spin-1/2 operators (S convention, J=1, periodic boundary conditions). Compute the full spectrum and verify E0 = -4.5 exactly.',
            successCriteria: ['E0 matches -4.5 to 12 digits'],
            validationChecks: ['Abs[E0 + 9/2] < 10^-10'],
            rationale: 'de-risk with a known case',
        },
        {
            title: 'Extend to L=6',
            task: 'Using the Hamiltonian utilities established in the previous stage, extend the computation to L=6 periodic XXX and produce the five lowest energies to 12 digits, checking SU(2) degeneracies.',
            successCriteria: ['5 lowest energies produced with degeneracy labels'],
            validationChecks: [],
            rationale: 'the target computation',
        },
    ],
});

const ASSESS_ACHIEVED = (stmt) => JSON.stringify({
    verdict: 'achieved', surprise: 'none',
    keyResults: [{ statement: stmt, evidence: 'clean.wb cell c1 output', confidence: 0.95 }],
    issues: [], stageNotes: 'HamXXX[L] utility is registered; spin convention S=sigma/2.',
    action: 'continue', reason: 'stage met its criteria',
});

const SYNTHESIS_OK = JSON.stringify({
    abstract: 'We computed the XXX spectrum for L=4 and L=6, verifying E0=-4.5 at L=4 against exact diagonalization and extracting the five lowest L=6 levels.',
    conclusions: ['E0(L=4) = -4.5 verified to 12 digits', 'Five lowest L=6 energies obtained with SU(2) degeneracy labels'],
    methodSummary: 'Direct construction of the Hamiltonian, exact diagonalization, kernel-verified pipeline.',
    literatureComparison: 'No literature comparison was made.',
    openProblems: ['Extend to L=8 via sparse methods'],
    novelty: { considerable: true, why: 'reusable spectrum pipeline', skillTitle: 'XXX chain spectrum pipeline', skillSummary: 'Build and diagonalize XXX chains with verified conventions.', skillMethod: 'Construct spin operators, assemble H, verify small-L, extend.' },
});

const REPORT_OK = [
    '%%BEGIN_REPORT',
    '\\begin{abstract}We computed the XXX spectrum for $L=4$ and $L=6$; the ground state energy $E_0=-4.5$ at $L=4$ matches exact diagonalization to 12 digits.\\end{abstract}',
    '\\section{Setup}Spin-1/2 XXX chain, $J=1$, periodic boundary conditions, $S=\\sigma/2$ convention.',
    '\\section{Results}\\begin{equation}E_0(L=4) = -\\tfrac{9}{2}\\end{equation} The five lowest $L=6$ levels were obtained with SU(2) degeneracy labels.',
    '\\section{Method}All results were produced in a Wolfram kernel; the delivered notebooks re-execute cleanly.',
    '\\section{Discussion}Open problem: extend to $L=8$.',
    '%%END_REPORT',
].join('\n');

// ── the suite ────────────────────────────────────────────────────────────────

(async () => {
    console.log('director.test.js');

    // ── D1: happy path ──────────────────────────────────────────────────────
    await ok('D1 happy path: 2 stages → synthesis → contribution → report', async () => {
        const root = freshRoot();
        const bus  = makeBus();
        const h1   = { utils: [{ name: 'HamXXX' }], facts: [] };
        const runStage = makeRunStage((args, i) => deliveredStageResult(root, {
            questId: 'Q9' + i,
            findings: i === 0 ? ['E0 = -4.5 verified for L=4'] : ['Five lowest L=6 energies computed'],
            handoff: h1,
        }));
        const llm = makeLlm((purpose) => {
            if (purpose === 'plan') return PLAN_2STAGE;
            if (purpose === 'assess') return ASSESS_ACHIEVED('E0(L=4) = -4.5 verified to 12 digits');
            if (purpose === 'synthesis') return SYNTHESIS_OK;
            if (purpose === 'report') return REPORT_OK;
            throw new Error('unexpected purpose ' + purpose);
        });
        let contributed = null;
        const { programme } = await runDirector({
            brief: 'Compute the XXX chain spectrum for L=4 and L=6 with verification.',
            root, bus,
            deps: {
                llm, runStage,
                contribute: async (args) => { contributed = args; return { candidateId: 'cand1', dir: '/tmp/c', draftPath: null, submitted: false }; },
            },
        });
        assert.strictEqual(programme.status, 'done');
        assert.strictEqual(programme.outcome.status, 'success');
        assert.strictEqual(runStage.calls.length, 2);
        assert.strictEqual(programme.stagesRun, 2);
        // Stage 2's task carries the banked key results + stage notes.
        assert.ok(runStage.calls[1].task.includes('ESTABLISHED RESULTS'), 'stage 2 task has key-results block');
        assert.ok(runStage.calls[1].task.includes('HANDOFF NOTES'), 'stage 2 task has handoff notes');
        // Kernel handoff threaded from stage 1 into stage 2.
        assert.strictEqual(runStage.calls[1].handoff, h1);
        // Key results banked (deduped: both stages returned the same statement).
        assert.ok(programme.keyResults.length >= 1);
        // Contribution raised (novelty considerable).
        assert.ok(contributed && contributed.synthesis, 'contribute called with synthesis');
        assert.strictEqual(programme.contribution.candidateId, 'cand1');
        // Report on disk, wrapped and complete.
        const tex = fs.readFileSync(programme.report.texPath, 'utf8');
        assert.ok(tex.includes('\\documentclass'), 'has preamble');
        assert.ok(tex.includes('\\begin{abstract}'), 'has abstract');
        assert.ok(tex.includes('E_0(L=4)'), 'has the result equation');
        assert.ok(tex.includes('Reproducibility'), 'lists notebooks');
        // Journal is consistent.
        const onDisk = await state.loadProgramme(programme.dir);
        assert.strictEqual(onDisk.status, 'done');
        // Telemetry spine.
        const types = bus.events.map(e => e.type);
        for (const t of ['director.started', 'director.plan', 'director.stage_started', 'director.stage_assessed', 'director.synthesised', 'director.finished']) {
            assert.ok(types.includes(t), `event ${t} emitted`);
        }
    });

    // ── D2: partial → consult_literature → informed revise ─────────────────
    await ok('D2 partial delivery → literature consult → informed retry', async () => {
        const root = freshRoot();
        const bus  = makeBus();
        const partialCharm = makeCharmDir(root, [{ key: 'H_built', value: 'SU(3) Hamiltonian verified', confidence: 0.9 }]);
        const partialNb = makeCleanNb(partialCharm, [
            { kind: 2, languageId: 'wolfram', value: 'H = HamSU3[6]', outputs: [{ items: [{ mime: 'text/plain', data: 'ok' }] }], metadata: {} },
        ]);
        const runStage = makeRunStage((args, i) => {
            if (i === 0) return {
                questId: 'Q80', charmDir: partialCharm, cleanNbPath: null, partialNbPath: partialNb,
                scroll: scrollOf({ status: 'partial_delivered', charmDir: partialCharm,
                    findings: ['SU(3) Hamiltonian constructed and verified'],
                    openQuestions: ['Nested BAE solver diverges — spectrum not extracted'], confidence: 0.5 }),
                handoff: { utils: [{ name: 'HamSU3' }], facts: [{ key: 'H_built', value: 'ok' }] },
            };
            return deliveredStageResult(root, { questId: 'Q81', findings: ['Full SU(3) spectrum via QQ-system'] });
        });
        let litQuestion = null;
        const literature = async ({ question }) => {
            litQuestion = question;
            return {
                question, plan: null,
                papers: [{ title: 'QQ-systems for rational spin chains', authors: ['A. Author'], year: 2020, arxivId: '2004.00001', doi: null, texkey: null, inspireId: null, ref: 'arXiv:2004.00001', relevant: true, grade: 'direct', reason: 'gives the QQ-system method that replaces nested BAE', fullText: true }],
                considered: [], uncertain: [], key_equations: [], observations: [{ text: 'QQ-system avoids nested-BAE divergence entirely', source: 'arXiv:2004.00001' }],
                diagnostics: { searched: 5, read: 1, relevant: 1 },
            };
        };
        let assessRound = 0;
        const llm = makeLlm((purpose) => {
            if (purpose === 'plan') {
                const p = JSON.parse(PLAN_2STAGE);
                p.stages = [p.stages[0]];
                p.stages[0].title = 'SU(3) L=6 spectrum';
                p.stages[0].task = 'Construct the SU(3) fundamental spin chain at L=6 and extract the full spectrum via nested Bethe ansatz, verifying against exact diagonalization.';
                return JSON.stringify(p);
            }
            if (purpose === 'assess' || purpose === 'assess_followup') {
                assessRound++;
                if (assessRound === 1) return JSON.stringify({
                    verdict: 'partial', surprise: 'minor',
                    keyResults: [{ statement: 'SU(3) L=6 Hamiltonian constructed and verified (Tr H = 0, hermiticity)', evidence: 'facts.json H_built', confidence: 0.9 }],
                    issues: ['nested BAE solver diverges'],
                    stageNotes: 'HamSU3[L] registered; blocker is the nested BAE numerics.',
                    action: 'consult_literature', reason: 'the blocker (nested BAE divergence) may have a known cure',
                    literatureQuestion: 'Numerically stable alternative to nested Bethe ansatz for SU(3) rational spin chains',
                });
                if (assessRound === 2) return JSON.stringify({
                    verdict: 'partial', surprise: 'minor',
                    keyResults: [{ statement: 'QQ-system identified as the stable method (arXiv:2004.00001)', evidence: 'literature brief L01', confidence: 0.7 }],
                    issues: [], stageNotes: 'Retry with the QQ-system; Hamiltonian utilities already banked.',
                    action: 'revise_stage', reason: 'literature gives a concrete stable method',
                    revisedStage: {
                        title: 'SU(3) L=6 spectrum via QQ-system',
                        task: 'Building on the established HamSU3 utilities and verified Hamiltonian, extract the full SU(3) L=6 spectrum via the QQ-system / quantum Wronskian method of arXiv:2004.00001 instead of nested BAE; verify against exact diagonalization.',
                        successCriteria: ['Spectrum matches exact diagonalization'], validationChecks: [],
                    },
                });
                return ASSESS_ACHIEVED('Full SU(3) L=6 spectrum extracted via QQ-system, matches exact diagonalization');
            }
            if (purpose === 'synthesis') {
                const s = JSON.parse(SYNTHESIS_OK);
                s.novelty.considerable = false;
                s.literatureComparison = 'Method taken from arXiv:2004.00001 and verified independently.';
                return JSON.stringify(s);
            }
            if (purpose === 'report') return REPORT_OK.replace('%%END_REPORT', '\\cite{Author2020}\n%%END_REPORT');
            throw new Error('unexpected purpose ' + purpose);
        });
        const { programme } = await runDirector({
            brief: 'Find the SU(3) L=6 spectrum.', root, bus,
            deps: { llm, runStage, literature, contribute: async () => null },
        });
        assert.strictEqual(programme.status, 'done');
        assert.strictEqual(programme.litConsultsUsed, 1);
        assert.ok(litQuestion && litQuestion.includes('nested Bethe ansatz'), 'literature asked about the blocker');
        assert.ok(fs.existsSync(path.join(programme.dir, 'literature', 'L01.json')), 'brief persisted');
        // Plan: failed attempt renamed to shadow id, revived stage delivered.
        const ids = programme.plan.stages.map(s => `${s.id}:${s.status}`);
        assert.deepStrictEqual(ids, ['S01r1:partial', 'S01:delivered'], `stages were ${ids}`);
        assert.strictEqual(programme.replansUsed, 1);
        // The retry started INFORMED: continuation banner + established results + revised method.
        const retryTask = runStage.calls[1].task;
        assert.ok(retryTask.includes('CONTINUATION'), 'retry task has continuation banner');
        assert.ok(retryTask.includes('ESTABLISHED RESULTS'), 'retry task has key results');
        assert.ok(retryTask.includes('QQ-system'), 'retry task carries the literature-informed method');
        // Handoff of the partial attempt flowed into the retry.
        assert.ok(runStage.calls[1].handoff && runStage.calls[1].handoff.utils[0].name === 'HamSU3');
        // Report cites the consulted paper via the deterministic bibliography.
        const tex = fs.readFileSync(programme.report.texPath, 'utf8');
        assert.ok(tex.includes('\\begin{thebibliography}'), 'bibliography present');
        assert.ok(tex.includes('arXiv:2004.00001'), 'consulted paper in bibliography');
        // The superseded partial attempt is history, not a plan item: the revised
        // stage delivered, so the programme is a success.
        assert.ok(programme.plan.stages[0].superseded, 'shadow attempt marked superseded');
        assert.strictEqual(programme.outcome.status, 'success', 'superseded attempt does not downgrade');
    });

    // ── D3: early stop_success ──────────────────────────────────────────────
    await ok('D3 stop_success skips remaining stages without downgrading', async () => {
        const root = freshRoot();
        const bus  = makeBus();
        const runStage = makeRunStage(() => deliveredStageResult(root, {}));
        const llm = makeLlm((purpose) => {
            if (purpose === 'plan') return PLAN_2STAGE;
            if (purpose === 'assess') {
                const a = JSON.parse(ASSESS_ACHIEVED('E0 verified; the L=6 values fell out of the same computation'));
                a.action = 'stop_success';
                a.reason = 'stage 1 already produced the L=6 spectrum too';
                return JSON.stringify(a);
            }
            if (purpose === 'synthesis') { const s = JSON.parse(SYNTHESIS_OK); s.novelty.considerable = false; return JSON.stringify(s); }
            if (purpose === 'report') return REPORT_OK;
            throw new Error('unexpected purpose ' + purpose);
        });
        const { programme } = await runDirector({
            brief: 'XXX spectrum programme', root, bus,
            deps: { llm, runStage, contribute: async () => null },
        });
        assert.strictEqual(runStage.calls.length, 1, 'only stage 1 ran');
        const s2 = programme.plan.stages[1];
        assert.strictEqual(s2.status, 'skipped');
        assert.strictEqual(s2.skipReason, 'stop_success');
        assert.strictEqual(programme.outcome.status, 'success', 'deliberate skip does not downgrade');
    });

    // ── D4: post-plan LLM blackout → deterministic fallbacks ───────────────
    await ok('D4 LLM blackout after plan → fallback assess/synthesis/report', async () => {
        const root = freshRoot();
        const bus  = makeBus();
        const runStage = makeRunStage(() => deliveredStageResult(root, { findings: ['E0 = -4.5 verified (fallback path)'] }));
        const llm = makeLlm((purpose) => {
            if (purpose === 'plan') return PLAN_2STAGE;
            throw new Error('provider down');
        });
        const { programme } = await runDirector({
            brief: 'XXX spectrum programme', root, bus,
            deps: { llm, runStage, contribute: async () => null },
        });
        assert.strictEqual(programme.status, 'done');
        assert.strictEqual(runStage.calls.length, 2, 'fallback assessment continues the plan');
        assert.ok(programme.keyResults.length >= 1, 'fallback banks scroll findings as key results');
        assert.ok(programme.synthesis.fallback, 'deterministic synthesis used');
        const tex = fs.readFileSync(programme.report.texPath, 'utf8');
        assert.ok(tex.includes('fallback path'), 'fallback report carries the findings');
        assert.strictEqual(programme.outcome.status, 'success');
    });

    // ── D5: abort mid-programme ─────────────────────────────────────────────
    await ok('D5 abort after first stage → programme aborted + persisted', async () => {
        const root = freshRoot();
        const bus  = makeBus();
        let abort = false;
        const runStage = makeRunStage(() => { abort = true; return deliveredStageResult(root, {}); });
        const llm = makeLlm((purpose) => {
            if (purpose === 'plan') return PLAN_2STAGE;
            return ASSESS_ACHIEVED('x');
        });
        let threw = null;
        try {
            await runDirector({
                brief: 'XXX spectrum programme', root, bus,
                deps: { llm, runStage, shouldAbort: () => abort, contribute: async () => null },
            });
        } catch (e) { threw = e; }
        assert.ok(threw && threw.kind === 'aborted', 'aborted error thrown');
        const started = bus.events.find(e => e.type === 'director.started');
        const onDisk = await state.loadProgramme(started.payload.dir);
        assert.strictEqual(onDisk.status, 'aborted');
        assert.ok(bus.events.some(e => e.type === 'director.aborted'));
    });

    // ── D6: resume skips completed stages, keeps key results ───────────────
    await ok('D6 resume: only pending stages run; prior results survive', async () => {
        const root = freshRoot();
        const bus  = makeBus();
        // Manufacture a half-finished programme on disk.
        const programme = await state.createProgramme({ root, goal: 'resume test goal' });
        programme.plan = { objective: 'obj', finalDeliverable: 'fd', version: 1, stages: [] };
        const s1 = state.makeStage({ id: 'S01', title: 'done stage', task: 'task one — already completed in a previous session with plenty of chars' });
        s1.status = 'delivered'; s1.attempt = 1; s1.questId = 'Q70';
        s1.assessment = { verdict: 'achieved', surprise: 'none', issues: [], action: 'continue', reason: 'ok' };
        s1.notesForNext = 'utility U1 registered';
        const s2 = state.makeStage({ id: 'S02', title: 'pending stage', task: 'task two — still to run, building on stage one utilities and results etc.' });
        s2.status = 'running';   // simulates a crash mid-stage → must be re-run
        programme.plan.stages.push(s1, s2);
        state.addKeyResult(programme, { stageId: 'S01', statement: 'prior key result: U1 verified', evidence: 'e', confidence: 0.9 });
        programme.stagesRun = 1;
        programme.status = 'running';
        await state.saveProgramme(programme);

        const runStage = makeRunStage(() => deliveredStageResult(root, { findings: ['stage two result'] }));
        const llm = makeLlm((purpose) => {
            if (purpose === 'assess') return ASSESS_ACHIEVED('stage two verified result');
            if (purpose === 'synthesis') { const s = JSON.parse(SYNTHESIS_OK); s.novelty.considerable = false; return JSON.stringify(s); }
            if (purpose === 'report') return REPORT_OK;
            throw new Error('unexpected purpose ' + purpose + ' (plan must NOT rerun on resume)');
        });
        const { programme: resumed } = await runDirector({
            resumeDir: programme.dir, root, bus,
            deps: { llm, runStage, contribute: async () => null },
        });
        assert.strictEqual(runStage.calls.length, 1, 'only the pending stage ran');
        assert.strictEqual(runStage.calls[0].stageId, 'S02');
        assert.ok(runStage.calls[0].task.includes('prior key result: U1 verified'), 'resumed stage sees prior key results');
        assert.strictEqual(resumed.status, 'done');
        assert.ok(resumed.keyResults.some(k => k.statement.includes('prior key result')));
        assert.ok(resumed.keyResults.some(k => k.statement.includes('stage two verified result')));
    });

    // ── parser units ─────────────────────────────────────────────────────────
    await ok('P1 parsePlanReply tolerates fences + prose', () => {
        const wrapped = 'Here is the plan:\n```json\n' + PLAN_2STAGE + '\n```';
        const p = prompts.parsePlanReply(wrapped);
        assert.ok(p.ok, JSON.stringify(p.errors));
        assert.strictEqual(p.value.stages.length, 2);
        assert.strictEqual(p.value.shortName, 'xxx_chain');
    });
    await ok('P2 parseAssessReply enforces conditional fields', () => {
        const bad = prompts.parseAssessReply(JSON.stringify({ verdict: 'partial', action: 'revise_stage' }));
        assert.ok(!bad.ok && bad.errors.some(e => e.includes('revisedStage')));
        const bad2 = prompts.parseAssessReply(JSON.stringify({ verdict: 'achieved', action: 'consult_literature' }));
        assert.ok(!bad2.ok && bad2.errors.some(e => e.includes('literatureQuestion')));
        const good = prompts.parseAssessReply(ASSESS_ACHIEVED('x'));
        assert.ok(good.ok && good.value.keyResults.length === 1);
    });
    await ok('P3 parseReportReply markers + minimum length', () => {
        const p = prompts.parseReportReply(REPORT_OK);
        assert.ok(p.ok);
        assert.ok(!p.value.includes('%%BEGIN_REPORT'));
        const short = prompts.parseReportReply('%%BEGIN_REPORT tiny %%END_REPORT');
        assert.ok(!short.ok);
        const stripped = prompts.parseReportReply('%%BEGIN_REPORT\n\\documentclass{article}\n' + 'x'.repeat(300) + '\n%%END_REPORT');
        assert.ok(stripped.ok && !stripped.value.includes('documentclass'));
    });
    await ok('P4 tryParseJson extracts first balanced object', () => {
        const r = prompts.tryParseJson('noise {"a": {"b": 1}} trailing');
        assert.ok(r.ok && r.value.a.b === 1);
    });

    // ── analyst units ────────────────────────────────────────────────────────
    await ok('A1 digestCleanNotebook flags error outputs', async () => {
        const root = freshRoot();
        const nb = makeCleanNb(root, [
            { kind: 2, languageId: 'wolfram', value: 'Good[1]', outputs: [{ items: [{ mime: 'text/plain', data: '42' }] }], metadata: {} },
            { kind: 2, languageId: 'wolfram', value: 'Bad[1]', outputs: [{ items: [{ mime: 'text/plain', data: '$Failed' }] }], metadata: {} },
        ]);
        const d = await analyst.digestCleanNotebook(nb);
        assert.ok(d.includes('→ 42'));
        assert.ok(d.includes('⚠ERROR'), 'error cell flagged');
    });
    await ok('A2 buildStageDigest merges scroll + facts + notebook', async () => {
        const root = freshRoot();
        const charmDir = makeCharmDir(root, [{ key: 'k1', value: 'v1', confidence: 0.8 }]);
        const nb = makeCleanNb(charmDir, [{ kind: 2, languageId: 'wolfram', value: 'x=1', outputs: [], metadata: {} }]);
        const d = await analyst.buildStageDigest({ scroll: scrollOf({ charmDir }), cleanNbPath: nb, charmDir });
        assert.ok(d.includes('SCROLL — status: delivered'));
        assert.ok(d.includes('k1 = v1'));
        assert.ok(d.includes('NOTEBOOK clean.wb'));
    });

    // ── report units ─────────────────────────────────────────────────────────
    await ok('R1 buildCitations dedupes and keys by author-year', () => {
        const prog = { literature: [
            { papers: [{ title: 'T1', authors: ['A. Smith'], year: 2020, arxivId: '2001.1' }, { title: 'T1', authors: ['A. Smith'], year: 2020, arxivId: '2001.1' }] },
            { papers: [{ title: 'T2', authors: ['B. Jones'], year: 2021, doi: '10.1/x' }] },
        ] };
        const cites = report.buildCitations(prog);
        assert.strictEqual(cites.length, 2);
        assert.ok(cites[0].key.startsWith('Smith'));
    });
    await ok('R2 texEscape neutralizes specials', () => {
        const e = report.texEscape('50% of $x_1 & #2 {a}');
        assert.ok(e.includes('\\%') && e.includes('\\$') && e.includes('\\_') && e.includes('\\&') && e.includes('\\#') && e.includes('\\{'));
    });

    // ── state units ──────────────────────────────────────────────────────────
    await ok('S1 addKeyResult dedupes; nextStageId ignores shadow ids', () => {
        const prog = { keyResults: [] };
        state.addKeyResult(prog, { stageId: 'S01', statement: 'A  result', confidence: 0.9 });
        state.addKeyResult(prog, { stageId: 'S02', statement: 'a result', confidence: 0.5 });
        assert.strictEqual(prog.keyResults.length, 1, 'normalized dedupe');
        const plan = { stages: [{ id: 'S01' }, { id: 'S01r1' }, { id: 'S03' }] };
        assert.strictEqual(state.nextStageId(plan), 'S04');
    });
    await ok('S2 listProgrammes surfaces status for the resume picker', async () => {
        const root = freshRoot();
        const p1 = await state.createProgramme({ root, goal: 'goal one' });
        p1.status = 'running'; await state.saveProgramme(p1);
        await state.createProgramme({ root, goal: 'goal two' });
        const list = await state.listProgrammes(root);
        assert.strictEqual(list.length, 2);
        assert.ok(list.some(p => p.status === 'running'));
    });

    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exit(failCount ? 1 : 0);
})();
