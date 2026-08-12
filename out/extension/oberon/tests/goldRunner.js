'use strict';
/**
 * Oberon — gold-suite engine (Stage 0 of the agent-upgrade plan).
 *
 * vscode-free: every environment touch-point is an injected dep, so the engine
 * is drivable from the extension (tests/runner.js, the goldRun command) and
 * unit-testable headlessly with mocks (house style: director.test.js).
 *
 * Grading is kernel-based, never LLM-based:
 *   dispatch brief (+ OUTPUT CONTRACT) → fairy run → fresh kernel →
 *   replay clean.wb → run task verifier → verdict.
 *
 * The per-run process rubric (tests/researchEval.js, deterministic) is attached
 * to every task result; compareGoldReports() is the promotion/regression gate.
 *
 * CLI (offline operations only — running the suite needs the live extension):
 *   node tests/goldRunner.js list
 *   node tests/goldRunner.js compare <baseline.json> <candidate.json> [--tolerance 0.02]
 */

const fs   = require('fs');
const path = require('path');
const SUITE = require('./suite');
const { assessTelemetry, compareReports } = require('./researchEval');

const SUITE_VERSION     = 'wolfbook-gold-suite/1.0.0';
const DEFAULT_TOLERANCE = 1e-6;
const REPLAY_TIMEOUT_S  = 300;
const VERIFY_TIMEOUT_S  = 60;

/**
 * WL helpers available to every task verifier. Kept tiny and dependency-free.
 * Installed in the fresh kernel right before the verifier runs.
 */
const VERIFIER_PRELUDE =
    'WBGold`sortNum[l_List] := SortBy[l, {Re[N[#]], Im[N[#]]} &];' +
    'WBGold`listDiff[a_List, b_List] := If[Length[a] =!= Length[b], Infinity,' +
    ' If[Length[a] == 0, 0, Max[Abs[N[WBGold`sortNum[a]] - N[WBGold`sortNum[b]]]]]];';

// ── task registry ───────────────────────────────────────────────────────────

function allTasks() { return SUITE.slice(); }

/** Resolve a subset spec ("TS01,GT02" | array | null=all). Throws on unknown ids. */
function resolveTasks(taskIds) {
    if (!taskIds || (Array.isArray(taskIds) && !taskIds.length)) return allTasks();
    const ids = (Array.isArray(taskIds) ? taskIds : String(taskIds).split(','))
        .map(s => String(s).trim().toUpperCase()).filter(Boolean);
    const byId = new Map(SUITE.map(t => [t.id, t]));
    const unknown = ids.filter(id => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown gold task id(s): ${unknown.join(', ')}`);
    return ids.map(id => byId.get(id));
}

/** The brief actually dispatched: task brief + explicit output contract. */
function buildContractBrief(task) {
    return task.brief +
        '\n\nOUTPUT CONTRACT: ' + task.contract +
        ' The delivered clean notebook MUST define exactly the symbol(s) named in this contract — ' +
        'an automated verifier will restart a fresh kernel, replay your clean notebook top to ' +
        'bottom, and machine-check the contract symbols. A run whose clean notebook does not ' +
        'define them counts as failed regardless of anything stated in prose.';
}

// ── verifier execution ──────────────────────────────────────────────────────

/**
 * Interpret the InputForm string a verifier evaluation returned.
 * Convention (mirrors charm validationChecks): True passes; a number passes
 * iff |value| < tolerance; anything else fails with the text as diagnostic.
 */
function interpretVerifierValue(valueStr, tolerance) {
    const tol = Number.isFinite(tolerance) ? tolerance : DEFAULT_TOLERANCE;
    let s = String(valueStr == null ? '' : valueStr).trim();
    // ToString[..., InputForm] wraps WL strings in quotes — unwrap for diagnostics.
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        s = s.slice(1, -1).replace(/\\"/g, '"');
    }
    if (s === 'True') return { pass: true, residual: null, detail: 'True' };
    // Numeric residual: plain real, *^ scientific notation, or exact rational.
    const num = s.replace(/\*\^/g, 'e').replace(/`+[0-9.]*/g, '');
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(num)) {
        const v = Number(num);
        return { pass: Math.abs(v) < tol, residual: v, detail: `residual ${s} (tol ${tol})` };
    }
    const frac = num.match(/^([-+]?\d+)\/(\d+)$/);
    if (frac) {
        const v = Number(frac[1]) / Number(frac[2]);
        return { pass: Math.abs(v) < tol, residual: v, detail: `residual ${s} (tol ${tol})` };
    }
    return { pass: false, residual: null, detail: s.slice(0, 500) || '(empty verifier result)' };
}

/**
 * Fresh-kernel verification of one finished task run.
 * @param {object} task   suite entry
 * @param {string} nbPath clean.wb (or clean_partial.wb) to replay
 * @param {{restartKernel:Function, runNotebook:Function, evalOnce:Function}} shim
 */
async function verifyTask(task, nbPath, shim) {
    const out = { pass: false, detail: '', residual: null, missingSymbols: [], replay: null };

    await shim.restartKernel();
    const replay = await shim.runNotebook(nbPath, { timeoutSeconds: REPLAY_TIMEOUT_S });
    out.replay = {
        cellCount: replay && replay.cellCount || 0,
        allClean:  !!(replay && replay.allClean),
        failures:  replay && Array.isArray(replay.failures) ? replay.failures.length : 0,
    };

    // NB: wolframShim.evalOnce takes a SINGLE args object ({expression, …});
    // calling it (code, opts) silently evaluates nothing ("expression is
    // empty") — the exact bug that voided the first baseline run (2026-08-01).
    const pre = await shim.evalOnce({ expression: VERIFIER_PRELUDE + ' "ok"', timeoutSeconds: 30 });
    if (!pre || !pre.ok) {
        out.detail = 'verifier prelude failed: ' + String(pre && (pre.error || pre.kind) || 'unknown');
        return out;
    }

    const symbols = Array.isArray(task.contractSymbols) ? task.contractSymbols : [];
    if (symbols.length) {
        const probe = symbols.map(s => `If[ValueQ[${s}] || DownValues[${s}] =!= {}, Nothing, "${s}"]`).join(', ');
        const r = await shim.evalOnce({ expression: `{${probe}}`, timeoutSeconds: 30 });
        if (r && r.ok) {
            const missing = String(r.value || '').match(/"([^"]+)"/g) || [];
            out.missingSymbols = missing.map(m => m.replace(/"/g, ''));
            if (out.missingSymbols.length) {
                out.detail = `contract symbol(s) not defined after replay: ${out.missingSymbols.join(', ')}`;
                return out;
            }
        }
    }

    const res = await shim.evalOnce({ expression: task.verifier, timeoutSeconds: VERIFY_TIMEOUT_S });
    if (!res || !res.ok) {
        out.detail = 'verifier evaluation failed: ' +
            String(res && (res.error || (res.messages || []).join('; ') || res.kind) || 'unknown');
        return out;
    }
    const verdict = interpretVerifierValue(res.value, task.tolerance);
    out.pass = verdict.pass;
    out.residual = verdict.residual;
    out.detail = verdict.detail;
    return out;
}

// ── verdicts ────────────────────────────────────────────────────────────────

/**
 * Combine run status (fairy terminal) with kernel verification into a verdict.
 * 'false_delivered' is THE Stage-2 gate metric: the run claimed delivered but
 * the kernel verifier disagrees.
 */
function combineVerdict(task, runStatus, verifier) {
    if (!verifier) return runStatus === 'delivered' ? 'unverified_delivered' : 'failed';
    const pass = verifier.pass;
    if (task.verify === 'manual') {
        return pass ? 'sanity_passed' : 'sanity_failed';
    }
    if (runStatus === 'delivered')          return pass ? 'verified' : 'false_delivered';
    if (runStatus === 'partial_delivered')  return pass ? 'partial_verified' : 'partial_failed';
    return 'failed';
}

/** Map an engine verdict onto the Test Results panel's badge vocabulary. */
function panelVerdict(verdict) {
    switch (verdict) {
        case 'verified':
        case 'partial_verified':    return verdict === 'verified' ? 'SUCCESS' : 'PARTIAL';
        case 'sanity_passed':       return 'NEEDS_REVIEW';
        case 'unverified_delivered':return 'NEEDS_REVIEW';
        case 'false_delivered':     return 'FAILED';
        case 'partial_failed':      return 'FAILED';
        case 'sanity_failed':       return 'FAILED';
        default:                    return 'FAILED';
    }
}

// ── economics ───────────────────────────────────────────────────────────────

function collectEconomics(events, durationMs) {
    const eco = {
        llmCalls: 0, toolCalls: 0, probes: 0, costUSD: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheMiss: 0 },
        durationMs,
    };
    for (const ev of events) {
        if (ev.type === 'llm.call') {
            eco.llmCalls++;
            const p = ev.payload || {};
            eco.costUSD += Number(p.costUSD) || 0;
            const u = p.usage || {};
            eco.tokens.input     += Number(u.inputTokens)  || 0;
            eco.tokens.output    += Number(u.outputTokens) || 0;
            eco.tokens.cacheRead += Number(u.cacheReadTokens != null ? u.cacheReadTokens : u.promptCacheHitTokens) || 0;
            eco.tokens.cacheMiss += Number(u.cacheMissTokens != null ? u.cacheMissTokens : u.promptCacheMissTokens) || 0;
        } else if (ev.type === 'tool.call')      eco.toolCalls++;
        else if (ev.type === 'probe.appended')   eco.probes++;
    }
    eco.costUSD = +eco.costUSD.toFixed(6);
    const cacheTotal = eco.tokens.cacheRead + eco.tokens.cacheMiss;
    eco.cacheHitRatio = cacheTotal ? +(eco.tokens.cacheRead / cacheTotal).toFixed(3) : null;
    return eco;
}

// ── the suite loop ──────────────────────────────────────────────────────────

/**
 * Run gold tasks sequentially through the live pipeline.
 *
 * @param {{
 *   dispatchBrief: (payload:{brief:string,questId:string,shortName:string,validationChecks:string[]}) => Promise<any>,
 *   bus:        { on:Function, removeListener:Function },
 *   runManager: { isActive: boolean },
 *   shim:       { restartKernel:Function, runNotebook:Function, evalOnce:Function, kernelStatus:Function },
 *   outDir:     string|null,
 *   log?:       (msg:string) => void,
 *   now?:       () => number,
 * }} deps
 * @param {{ taskIds?: string[]|string, label?: string, signal?: AbortSignal,
 *           onTaskStarted?: Function, onTaskDone?: Function }} [opts]
 */
async function runGoldSuite(deps, opts = {}) {
    const log = deps.log || (() => {});
    const now = deps.now || Date.now;
    const tasks = resolveTasks(opts.taskIds);
    const label = String(opts.label || 'gold').replace(/[^\w.-]+/g, '_').slice(0, 40);

    const k = deps.shim.kernelStatus();
    if (!k || !k.available) {
        throw new Error(`Wolfram kernel is not available (${k && k.reason || 'unknown'}). ` +
            'Open a .wb notebook to start a kernel before running the gold suite.');
    }
    if (deps.runManager.isActive) {
        throw new Error('A run is already active — abort it before starting the gold suite.');
    }

    const startedAt = now();
    const results = [];
    let build = null;

    for (let i = 0; i < tasks.length; i++) {
        if (opts.signal && opts.signal.aborted) break;
        const task = tasks[i];
        if (opts.onTaskStarted) opts.onTaskStarted({ index: i, task });
        log(`[gold] ${task.id} (${i + 1}/${tasks.length}) dispatching…`);

        const taskStart = now();
        const events = [];
        const onEvent = (ev) => { events.push(ev); };
        deps.bus.on('event', onEvent);

        const stamp = taskStart.toString(36).slice(-6);
        const questId = `QG_${task.id}_${stamp}`;
        const shortName = `gold_${task.id.toLowerCase()}`;

        let dispatchError = null;
        try {
            await deps.dispatchBrief({
                brief: buildContractBrief(task),
                questId, shortName,
                validationChecks: (task.validationChecks || []).slice(),
            });
        } catch (e) {
            dispatchError = e && e.message || String(e);
        } finally {
            deps.bus.removeListener('event', onEvent);
        }

        const p = (ev) => (ev && ev.payload) || {};
        const started  = events.find(e => e.type === 'fairy.started');
        const scroll   = [...events].reverse().find(e => e.type === 'scroll.submitted');
        const metrics  = [...events].reverse().find(e => e.type === 'fairy.run_metrics');
        const runId    = events.length ? (events[0].runId || null) : null;
        const charmDir = p(started).charmDir || null;
        const status   = p(scroll).status || (dispatchError ? 'error' : 'unknown');
        if (!build) build = p(started).build || null;

        // Fresh-kernel verification against the delivered (or partial) notebook.
        let verifier = null;
        let verifyError = null;
        let verifiedNb = null;
        if (charmDir) {
            const clean   = path.join(charmDir, 'clean.wb');
            const partial = path.join(charmDir, 'clean_partial.wb');
            verifiedNb = fs.existsSync(clean) ? clean : (fs.existsSync(partial) ? partial : null);
        }
        if (verifiedNb) {
            log(`[gold] ${task.id} verifying against ${path.basename(verifiedNb)}…`);
            try { verifier = await verifyTask(task, verifiedNb, deps.shim); }
            catch (e) { verifyError = e && e.message || String(e); }
        }

        const verdict = combineVerdict(task, status, verifier);
        let rubric = null;
        try {
            const rep = assessTelemetry(events, { runId, taskId: task.id });
            rubric = { score: rep.summary.score, coverage: rep.summary.assessmentCoverage, report: rep };
        } catch (_) {}

        const result = {
            id: task.id, title: task.title, category: task.category, verify: task.verify,
            questId, runId, charmDir, verifiedNb,
            status, verdict,
            scrollConfidence: (typeof p(scroll).confidence === 'number') ? p(scroll).confidence : null,
            needsReview: verdict === 'sanity_passed' || verdict === 'unverified_delivered',
            verifier, verifyError,
            economics: collectEconomics(events, now() - taskStart),
            metrics: p(metrics) || null,
            rubric: rubric ? { score: rubric.score, coverage: rubric.coverage } : null,
            error: dispatchError,
        };
        results.push(result);
        if (opts.onTaskDone) opts.onTaskDone({ index: i, task, result });
        log(`[gold] ${task.id} → ${verdict}${verifier ? ` (${verifier.detail})` : ''}`);
    }

    const report = buildReport({ results, label, build, startedAt, finishedAt: now() });
    if (deps.outDir) {
        try {
            fs.mkdirSync(deps.outDir, { recursive: true });
            const file = path.join(deps.outDir,
                `gold-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${label}.json`);
            fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
            report.reportPath = file;
            log(`[gold] report written: ${file}`);
        } catch (e) {
            log(`[gold] report write failed: ${e.message}`);
        }
    }
    return report;
}

function buildReport({ results, label, build, startedAt, finishedAt }) {
    const byVerdict = {};
    for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    const fullTasks = results.filter(r => r.verify === 'full');
    const verified = results.filter(r => r.verdict === 'verified').length;
    const falseDelivered = results.filter(r => r.verdict === 'false_delivered').length;
    const delivered = results.filter(r => r.status === 'delivered').length;
    const cost = +(results.reduce((s, r) => s + (r.economics.costUSD || 0), 0)).toFixed(6);
    const cacheRatios = results.map(r => r.economics.cacheHitRatio).filter(x => x != null);

    return {
        schemaVersion: SUITE_VERSION,
        generatedAt: new Date(finishedAt).toISOString(),
        label, build,
        durationMs: finishedAt - startedAt,
        tasks: results,
        summary: {
            total: results.length,
            byVerdict,
            passRate: fullTasks.length ? +(fullTasks.filter(r => r.verdict === 'verified').length / fullTasks.length).toFixed(3) : null,
            verified,
            falseDelivered,
            falseDeliveredRate: delivered ? +(falseDelivered / delivered).toFixed(3) : null,
            totalCostUSD: cost,
            meanCacheHitRatio: cacheRatios.length ? +(cacheRatios.reduce((a, b) => a + b, 0) / cacheRatios.length).toFixed(3) : null,
        },
    };
}

// ── panel analytics (deterministic — replaces the old LLM grading call) ─────

const VERDICT_REASONS = {
    verified:            'Delivered and the fresh-kernel verifier confirmed the result.',
    false_delivered:     'Run claimed delivered but the kernel verifier REFUTED the result.',
    partial_verified:    'Partial delivery, but the verifier confirmed the contract result.',
    partial_failed:      'Partial delivery and the verifier could not confirm the result.',
    sanity_passed:       'Sanity checks passed (manual-review task — grading is not fully automatic).',
    sanity_failed:       'Sanity checks failed on this manual-review task.',
    unverified_delivered:'Delivered but no verifiable artifact was found to check.',
    failed:              'Run did not deliver a verifiable result.',
};

function buildAnalytics(results) {
    const verdicts = results.map(r => ({
        id: r.id,
        verdict: panelVerdict(r.verdict),
        reason: (VERDICT_REASONS[r.verdict] || r.verdict) +
            (r.verifier && r.verifier.detail && r.verdict !== 'verified' ? ` [${String(r.verifier.detail).slice(0, 160)}]` : ''),
    }));
    const nSuccess = verdicts.filter(v => v.verdict === 'SUCCESS').length;
    const falseDel = results.filter(r => r.verdict === 'false_delivered').length;
    const narrative =
        `Kernel-verified grading (no LLM judge): ${nSuccess}/${results.length} fully verified` +
        (falseDel ? `; ${falseDel} FALSE-DELIVERED (claimed success refuted by the kernel — investigate first)` : '') +
        `. Cost $${(results.reduce((s, r) => s + (r.economics && r.economics.costUSD || 0), 0)).toFixed(3)}.`;
    return {
        parsed: { verdicts, narrative, overallScore: `${nSuccess}/${results.length}` },
        text: narrative,
        modelCalled: false,
        grader: 'kernel',
    };
}

// ── baseline comparison (the promotion gate) ────────────────────────────────

const VERDICT_RANK = {
    verified: 4, partial_verified: 3, sanity_passed: 3, unverified_delivered: 2,
    partial_failed: 1, sanity_failed: 1, false_delivered: 0, failed: 0,
};

/**
 * Compare two gold reports task-by-task: verdict transitions, cost deltas,
 * and the process-rubric deltas via researchEval.compareReports.
 */
function compareGoldReports(baseline, candidate, { tolerance = 0.02, costTolerance = 0.25 } = {}) {
    const bTasks = new Map((baseline.tasks || []).map(t => [t.id, t]));
    const rows = [];
    for (const c of (candidate.tasks || [])) {
        const b = bTasks.get(c.id);
        if (!b) { rows.push({ id: c.id, classification: 'new', verdict: c.verdict }); continue; }
        const dv = (VERDICT_RANK[c.verdict] ?? 0) - (VERDICT_RANK[b.verdict] ?? 0);
        const bCost = b.economics && b.economics.costUSD || 0;
        const cCost = c.economics && c.economics.costUSD || 0;
        const costDelta = +(cCost - bCost).toFixed(6);
        let classification = 'stable';
        if (dv < 0) classification = 'regression';
        else if (dv > 0) classification = 'improvement';
        else if (bCost > 0 && costDelta / bCost > costTolerance) classification = 'cost_regression';
        else if (bCost > 0 && costDelta / bCost < -costTolerance) classification = 'cost_improvement';
        rows.push({
            id: c.id, before: b.verdict, after: c.verdict, classification,
            costBefore: bCost, costAfter: cCost, costDelta,
            rubricBefore: b.rubric && b.rubric.score, rubricAfter: c.rubric && c.rubric.score,
        });
    }
    const missing = [...bTasks.keys()].filter(id => !(candidate.tasks || []).some(t => t.id === id));
    return {
        tolerance, costTolerance,
        regressions: rows.filter(r => r.classification === 'regression'),
        costRegressions: rows.filter(r => r.classification === 'cost_regression'),
        improvements: rows.filter(r => r.classification === 'improvement' || r.classification === 'cost_improvement'),
        missingFromCandidate: missing,
        rows,
        summaryDelta: {
            passRate: [baseline.summary && baseline.summary.passRate, candidate.summary && candidate.summary.passRate],
            falseDeliveredRate: [baseline.summary && baseline.summary.falseDeliveredRate, candidate.summary && candidate.summary.falseDeliveredRate],
            totalCostUSD: [baseline.summary && baseline.summary.totalCostUSD, candidate.summary && candidate.summary.totalCostUSD],
        },
    };
}

// ── offline verification (wolframscript replay — no extension needed) ───────

/** Locate a runnable wolframscript (PATH, then known app bundles). */
function findWolframscript() {
    const { spawnSync } = require('child_process');
    const candidates = [
        'wolframscript',
        '/Applications/Wolfram 3.app/Contents/MacOS/wolframscript',
        '/Applications/Wolfram.app/Contents/MacOS/wolframscript',
        '/Applications/Wolfram 2.app/Contents/MacOS/wolframscript',
        '/Applications/Mathematica.app/Contents/MacOS/wolframscript',
    ];
    for (const c of candidates) {
        try {
            const r = spawnSync(c, ['-code', '1+1'], { timeout: 60000, encoding: 'utf8' });
            if (r.status === 0 && /2/.test(r.stdout || '')) return c;
        } catch (_) {}
    }
    return null;
}

/** Extract code-cell sources (kind === 2) from a .wb notebook JSON file. */
function extractCodeCells(nbPath) {
    const nb = JSON.parse(fs.readFileSync(nbPath, 'utf8'));
    return (nb.cells || []).filter(c => c && c.kind === 2 && c.value).map(c => String(c.value));
}

/**
 * Replay a run's clean notebook in a fresh wolframscript kernel and run the
 * task's verifier — same semantics as verifyTask but with zero extension
 * dependencies. Used by the `verify` CLI to (re-)grade finished runs from
 * their on-disk artifacts.
 */
function offlineVerifyTask(task, nbPath, wolframscriptPath, { timeoutMs = 10 * 60 * 1000 } = {}) {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const out = { pass: false, detail: '', residual: null, missingSymbols: [], replay: { offline: true } };

    let cells;
    try { cells = extractCodeCells(nbPath); }
    catch (e) { out.detail = `cannot read notebook: ${e.message}`; return out; }
    out.replay.cellCount = cells.length;

    const symbols = Array.isArray(task.contractSymbols) ? task.contractSymbols : [];
    const missingExpr = symbols.length
        ? `{${symbols.map(s => `If[ValueQ[${s}] || DownValues[${s}] =!= {}, Nothing, "${s}"]`).join(', ')}}`
        : '{}';

    const script =
        cells.join('\n') + '\n' +
        VERIFIER_PRELUDE + '\n' +
        `WBRV\`missing = ${missingExpr};\n` +
        'Print["WBRV-MISSING " <> ExportString[WBRV`missing, "JSON", "Compact" -> True]];\n' +
        'If[WBRV`missing === {},\n' +
        ` WBRV\`res = Quiet[Check[${task.verifier}, "FAILEVAL: " <> ToString[$MessageList]]];\n` +
        ' Print["WBRV-VALUE " <> ExportString[<|"v" -> ToString[WBRV`res, InputForm]|>, "JSON", "Compact" -> True]]];\n';

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gold-verify-')), `${task.id}.wls`);
    fs.writeFileSync(file, script, 'utf8');

    let stdout = '';
    try {
        stdout = execFileSync(wolframscriptPath, ['-file', file], { timeout: timeoutMs, encoding: 'utf8' });
    } catch (e) {
        out.detail = `offline replay failed: ${e.message}` +
            (e.stdout ? ` | tail: ${String(e.stdout).slice(-300)}` : '');
        return out;
    }

    const missLine = stdout.split('\n').find(l => l.startsWith('WBRV-MISSING '));
    if (missLine) {
        try { out.missingSymbols = JSON.parse(missLine.slice('WBRV-MISSING '.length)); } catch (_) {}
    }
    if (out.missingSymbols.length) {
        out.detail = `contract symbol(s) not defined after replay: ${out.missingSymbols.join(', ')}`;
        return out;
    }
    const valLine = stdout.split('\n').find(l => l.startsWith('WBRV-VALUE '));
    if (!valLine) {
        out.detail = 'offline replay produced no verifier value | tail: ' + stdout.slice(-300);
        return out;
    }
    let valueStr = '';
    try { valueStr = JSON.parse(valLine.slice('WBRV-VALUE '.length)).v; }
    catch (e) { out.detail = `cannot parse verifier value: ${e.message}`; return out; }

    const verdict = interpretVerifierValue(valueStr, task.tolerance);
    out.pass = verdict.pass;
    out.residual = verdict.residual;
    out.detail = verdict.detail;
    return out;
}

/**
 * Re-grade every task of an existing gold report from its on-disk artifacts,
 * using the CURRENT suite verifiers. Returns a fresh report object; economics
 * and run statuses are carried over untouched.
 */
function reverifyReport(report, wolframscriptPath, log = () => {}) {
    const byId = new Map(SUITE.map(t => [t.id, t]));
    const results = [];
    for (const t of (report.tasks || [])) {
        const task = byId.get(t.id);
        const copy = Object.assign({}, t);
        if (!task) { copy.verifyError = 'task no longer in suite'; results.push(copy); continue; }
        let nb = t.verifiedNb;
        if ((!nb || !fs.existsSync(nb)) && t.charmDir) {
            const clean = path.join(t.charmDir, 'clean.wb');
            const partial = path.join(t.charmDir, 'clean_partial.wb');
            nb = fs.existsSync(clean) ? clean : (fs.existsSync(partial) ? partial : null);
        }
        if (!nb) { copy.verifyError = 'no artifact on disk'; results.push(copy); continue; }
        log(`[gold verify] ${t.id} replaying ${nb} …`);
        copy.verifier = offlineVerifyTask(task, nb, wolframscriptPath);
        copy.verifiedNb = nb;
        copy.verifyError = null;
        copy.verdict = combineVerdict(task, t.status, copy.verifier);
        copy.needsReview = copy.verdict === 'sanity_passed' || copy.verdict === 'unverified_delivered';
        copy.reverified = true;
        log(`[gold verify] ${t.id} → ${copy.verdict} (${copy.verifier.detail})`);
        results.push(copy);
    }
    const startedAt = Date.parse(report.generatedAt) || Date.now();
    const rep = buildReport({ results, label: `${report.label || 'gold'}-reverified`, build: report.build, startedAt, finishedAt: Date.now() });
    rep.reverifiedFrom = report.reportPath || null;
    return rep;
}

// ── CLI (offline ops only) ──────────────────────────────────────────────────

function cliMain(argv) {
    const cmd = argv[2];
    if (cmd === 'list') {
        for (const t of SUITE) {
            process.stdout.write(`${t.id}  [${t.verify.padEnd(7)}] (${t.category}) ${t.title}\n`);
        }
        return 0;
    }
    if (cmd === 'verify') {
        const files = argv.slice(3).filter(a => !a.startsWith('--'));
        if (files.length !== 1) { process.stderr.write('usage: goldRunner.js verify <report.json>\n'); return 1; }
        const ws = findWolframscript();
        if (!ws) { process.stderr.write('wolframscript not found — cannot verify offline.\n'); return 1; }
        const reportPath = path.resolve(files[0]);
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const rep = reverifyReport(report, ws, (m) => process.stderr.write(m + '\n'));
        const outPath = reportPath.replace(/\.json$/, '') + '-reverified.json';
        fs.writeFileSync(outPath, JSON.stringify(rep, null, 2), 'utf8');
        process.stdout.write(JSON.stringify({
            report: outPath,
            summary: rep.summary,
            tasks: rep.tasks.map(t => ({ id: t.id, verdict: t.verdict, detail: t.verifier && String(t.verifier.detail).slice(0, 120) })),
        }, null, 2) + '\n');
        return 0;
    }
    if (cmd === 'compare') {
        const files = argv.slice(3).filter(a => !a.startsWith('--'));
        if (files.length !== 2) { process.stderr.write('usage: goldRunner.js compare <baseline.json> <candidate.json>\n'); return 1; }
        const tolFlag = argv.find(a => a.startsWith('--tolerance'));
        const tolerance = tolFlag ? Number(tolFlag.split('=')[1] || argv[argv.indexOf(tolFlag) + 1]) : 0.02;
        const [b, c] = files.map(f => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
        const diff = compareGoldReports(b, c, { tolerance });
        process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
        return diff.regressions.length ? 2 : 0;
    }
    process.stdout.write(
        'Oberon gold suite — offline CLI\n' +
        '  node goldRunner.js list                          list tasks\n' +
        '  node goldRunner.js compare <base> <cand>         diff two reports (exit 2 on regression)\n' +
        'Running the suite needs the live extension: use the "Oberon: Run Test Suite" panel,\n' +
        'the headless command wolfbook.oberon.goldRun {tasks, label}, or the MCP tool wolfbook_gold_run.\n');
    return 1;
}

if (require.main === module) process.exit(cliMain(process.argv));

module.exports = {
    SUITE_VERSION, VERIFIER_PRELUDE, DEFAULT_TOLERANCE,
    allTasks, resolveTasks, buildContractBrief,
    interpretVerifierValue, verifyTask, combineVerdict, panelVerdict,
    collectEconomics, runGoldSuite, buildReport, buildAnalytics,
    compareGoldReports, compareReports,
    findWolframscript, extractCodeCells, offlineVerifyTask, reverifyReport,
};
