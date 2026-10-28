'use strict';
// Regressions from field report feedbac10 (2026-09-30, gamma-qsc-xy-eps.wb):
//   1. abort never reached a kernel busy with a DIRECT evaluation
//      (evaluateExpression) — abortAndWait / kernelControl looked only at cells;
//   2/3. every tools/call was held 2 s, whatever timeoutSeconds / wait_seconds
//      said, and operationStatus came back as a NEW handle of its own;
//   4/5/6. unknown parameters were silently ignored (editCell old_string,
//      getNotebookContext start/end and mode:"brief") and replied ok:true.

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require('./_stub-vscode');
    return originalLoad.apply(this, arguments);
};
const { WolframMCPServer } = require('../../claude-mcp/server');
const { checkToolArguments } = require('../../claude-mcp/param-check');
const { KernelArbiter } = require('../../kernel/arbiter');
const { WolframNotebookKernel } = require('../../controller');
Module._load = originalLoad;

const pkg = require('../../../../package.json');
const schemaOf = name => pkg.contributes.languageModelTools.find(t => t.name === name).inputSchema;
const known = new Set(pkg.contributes.languageModelTools.flatMap(t => Object.keys(t.inputSchema?.properties || {})));

(async () => {
    // ── 4/5/6: argument check ─────────────────────────────────────────────
    let r = checkToolArguments('wolfbook_editCell', { cell_id: 'c1', old_string: 'a', new_string: 'b' },
        schemaOf('wolfbook_editCell'), known);
    assert.deepStrictEqual(r.unknown, []);
    assert.deepStrictEqual(r.args, { cellId: 'c1', old_string: 'a', new_string: 'b' }, 'cell_id → cellId');

    r = checkToolArguments('wolfbook_editCell', { cellId: 'c1', content: 'x', bogus_flag: 1 },
        schemaOf('wolfbook_editCell'), known);
    assert.deepStrictEqual(r.unknown, ['bogus_flag'], 'unknown key is refused');

    r = checkToolArguments('wolfbook_editCell', { cellId: 'c1', content: 'x', run: false },
        schemaOf('wolfbook_editCell'), known);
    assert.strictEqual(r.args.evaluate, false, 'run → evaluate');

    // Re-test: the agent sent run:"false" as a STRING — evaluate:"false" is
    // truthy and editCell evaluated the cell anyway.
    r = checkToolArguments('wolfbook_editCell', { cellId: 'c1', old_string: 'a', new_string: 'b', run: 'false' },
        schemaOf('wolfbook_editCell'), known);
    assert.strictEqual(r.args.evaluate, false, 'run:"false" → evaluate:false (boolean)');
    r = checkToolArguments('wolfbook_editCell', { cells: [{ cellId: 'c1', content: 'x', evaluate: 'false' }] },
        schemaOf('wolfbook_editCell'), known);
    assert.strictEqual(r.args.cells[0].evaluate, false, 'nested cells[].evaluate coerced');
    r = checkToolArguments('wolfbook_editCell', { cellId: 'c1', content: 'true' }, schemaOf('wolfbook_editCell'), known);
    assert.strictEqual(r.args.content, 'true', 'string parameters are never coerced');
    r = checkToolArguments('wolfbook_getNotebookContext', { mode: 'brief', start: '40', end: '50' },
        schemaOf('wolfbook_getNotebookContext'), known);
    assert.deepStrictEqual(r.args, { action: 'brief', startCell: 40, endCell: 50 }, 'numeric strings → numbers');

    r = checkToolArguments('wolfbook_getNotebookContext', { start: 42, end: 42 },
        schemaOf('wolfbook_getNotebookContext'), known);
    assert.deepStrictEqual(r.args, { startCell: 42, endCell: 42 }, 'start/end → startCell/endCell');

    r = checkToolArguments('wolfbook_getNotebookContext', { mode: 'brief' },
        schemaOf('wolfbook_getNotebookContext'), known);
    assert.deepStrictEqual(r.args, { action: 'brief' }, 'mode is not tolerated as "known elsewhere"');

    r = checkToolArguments('wolfbook_insertCells', { after_cell_id: 'c9', content: 'x', kind: 'code' },
        schemaOf('wolfbook_insertCells'), known);
    assert.strictEqual(r.args.afterCellId, 'c9', 'after_cell_id → afterCellId');

    // Explicit spelling wins over an alias of it.
    r = checkToolArguments('wolfbook_getNotebookContext', { start: 1, startCell: 5 },
        schemaOf('wolfbook_getNotebookContext'), known);
    assert.deepStrictEqual(r.unknown, ['start']);

    // Through the server: refused before dispatch, and the message names valid params.
    const srv = new WolframMCPServer(new Map(), [{ name: 'wolfbook_editCell', inputSchema: schemaOf('wolfbook_editCell') }]);
    let dispatched = 0;
    srv._dispatch = async () => { dispatched++; return { content: [{ type: 'text', text: 'ok' }] }; };
    const refused = await srv._processMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'wolfbook_editCell', arguments: { cellId: 'c', content: 'x', frobnicate: true } } }, 's1');
    assert.strictEqual(dispatched, 0);
    assert.strictEqual(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /unknown parameter "frobnicate".*Valid parameters: .*old_string/);

    // Re-test: a coerced value reaches the tool even when nothing was renamed.
    let seenArgs;
    srv._dispatch = async (_m, params) => { seenArgs = params.arguments; return { content: [{ type: 'text', text: 'ok' }] }; };
    await srv._processMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'wolfbook_editCell', arguments: { cellId: 'c', content: 'x', evaluate: 'false' } } }, 's1');
    assert.strictEqual(seenArgs.evaluate, false, 'evaluate:"false" dispatched as boolean false');

    // ── Found while re-testing: target adoption is for RECONNECTS only ────
    // Every Claude Code session is clientInfo.name "claude-code"; a second LIVE
    // session in another workspace inherited the first one's notebook + kernel.
    const tgt = new WolframMCPServer(new Map(), []);
    const target = { clientId: 'VSCode[A]', notebook: 'a.wb', kernelId: 'k-a', ts: Date.now() };
    for (const sid of ['live-1', 'live-2', 'recon']) {
        tgt._sessionClientNames.set(sid, 'claude-code');
    }
    tgt._sessionConnectedAt.set('live-1', Date.now());
    tgt._sessionConnectedAt.set('live-2', Date.now());
    tgt._lastTargetByClient.set('claude-code', { target, ts: Date.now(), sessionId: 'live-1' });
    assert.strictEqual(tgt._adoptLastTarget('live-2'), null, 'a concurrent live session does not inherit the target');
    tgt._sessionConnectedAt.delete('live-1');          // the owner disconnected …
    tgt._sessionConnectedAt.set('recon', Date.now());
    assert.strictEqual(tgt._adoptLastTarget('recon'), null, 'product names never recover a disconnected agent target; use a resume token');
    assert.strictEqual(tgt._adoptLastTarget('live-2'), null, 'and only that one reconnect');

    // ── 2/3: inline wait honours the request, capped per client ───────────
    const slow = new WolframMCPServer(new Map(), [], { initialWaitMs: 50 });
    slow._sessionClientNames.set('codex-s', 'codex-mcp-client');
    slow._sessionClientNames.set('cc-s', 'claude-code');
    assert.strictEqual(slow._inlineWaitFor({ name: 'wolfbook_runCell', arguments: {} }, 'cc-s').waitMs, 50);
    assert.strictEqual(slow._inlineWaitFor({ name: 'wolfbook_evaluateExpression', arguments: { timeoutSeconds: 10 } }, 'codex-s').waitMs, 12000);
    const capped = slow._inlineWaitFor({ name: 'wolfbook_evaluateExpression', arguments: { timeoutSeconds: 1800 } }, 'codex-s');
    assert.strictEqual(capped.waitMs, 55000);
    assert.match(capped.note, /capped at 55 s/);
    assert.strictEqual(slow._inlineWaitFor({ name: 'wolfbook_evaluateExpression', arguments: { timeoutSeconds: 1800 } }, 'cc-s').waitMs, 300000);
    assert.strictEqual(slow._inlineWaitFor({ name: 'wolfbook_evaluateExpression', arguments: { timeoutSeconds: 60, wait_mode: 'async' } }, 'cc-s').waitMs, 50);

    // An evaluation that finishes inside its timeout comes back inline (was: a handle at 2 s).
    slow._dispatch = async () => new Promise(res => setTimeout(() => res({ content: [{ type: 'text', text: 'Out = 42' }] }), 150));
    const inline = await slow._runManagedToolCall({ name: 'wolfbook_evaluateExpression', arguments: { expression: '1', timeoutSeconds: 5 } }, 'codex-s');
    assert.strictEqual(inline.content[0].text, 'Out = 42');

    // operationStatus' own wait is clamped into the window, so it answers about
    // the QUERIED id instead of turning into a new handle.
    let seenWait;
    slow._dispatch = async (_m, params) => { seenWait = params.arguments.wait_seconds; return { content: [{ type: 'text', text: '{"state":"running"}' }] }; };
    await slow._runManagedToolCall({ name: 'wolfbook_operationStatus', arguments: { operation_id: 'x', wait_seconds: 300 } }, 'codex-s');
    assert.strictEqual(seenWait, 53, 'wait_seconds clamped below the 55 s cap');

    // A still-running reply reports real elapsed time, not the fast window.
    const msg = slow._operationStillRunningResult({ id: 'op', startedAt: Date.now() - 61000 }, 'why').content[0].text;
    assert.match(msg, /after 61 seconds/);
    assert.match(msg, /why/);

    // ── 1: abort reaches a direct evaluation ──────────────────────────────
    let aborts = 0;
    const ctrl = Object.create(WolframNotebookKernel.prototype);
    Object.assign(ctrl, {
        executionQueue: { queueLength: () => 0, queue: [], clear() {}, forceEndAll() {} },
        _evalDispatched: false, isAborting: false, _abortPending: false,
        _directEvaluationCount: 1, kernelStatusString: 'resolved',
        session: { abort: () => { aborts++; if (aborts >= 2) ctrl._directEvaluationCount = 0; return true; }, closeAllDialogs() {} },
        writeDebugLog() {}, outputPanel: { print() {} },
    });
    ctrl.arbiter = new KernelArbiter();
    const lease = (await ctrl.arbiter.acquire(ctrl, { owner: 'mcp', kind: 'scratch-evaluation' }));
    assert.ok(!lease.lease, 'a busy direct link refuses a second lease');
    ctrl._directEvaluationCount = 1;
    const t0 = Date.now();
    await ctrl.abortAndWait(8000, { notifyPriority: false });
    assert.ok(aborts >= 2, `abort sent and re-sent to a direct evaluation (sent ${aborts})`);
    assert.strictEqual(ctrl._directEvaluationCount, 0);
    assert.ok(Date.now() - t0 < 8000, 'returned once the link went idle');

    // ── preview "7(1.000…, 3)": user code shadowed N — the lint says so ──
    const { findShadowedBuiltins: lint } = require('../../syntax/shadow-lint');
    const reported = 'Module[{q = 1, cd, th, N = 7, rules, vals}, vals = Block[{$MinPrecision = 40}, ' +
        'ScientificForm[N[Abs[SetPrecision[xlEntry[i, r, col, N] /. rules, 40]], 3], 2]]]';
    assert.deepStrictEqual(lint(reported).map(w => w.name), ['N']);
    assert.match(lint(reported)[0].message, /7\[x, 3\]/);
    assert.deepStrictEqual(lint('Module[{C}, C[x_] := x^2; C[3]]'), [], 'a local function the body defines is deliberate');
    assert.deepStrictEqual(lint('Module[{D = m}, D[[1, 2]]]'), [], 'Part on the local value is fine');
    assert.deepStrictEqual(lint('Module[{E}, E = Table[1, {3}]; E[[1]]]'), [], 'E as a plain variable is fine');
    assert.deepStrictEqual(lint('Module[{E = 2}, E^x]').map(w => w.name), ['E']);
    assert.deepStrictEqual(lint('Module[{n = 7}, "N[x]" (* N[y] *) ; N[x, 3]]'), []);
    assert.deepStrictEqual(lint('With[{N = 3}, N[Pi]]').map(w => w.scope), ['With']);

    console.log('feedback10 regressions: OK');
})().catch(err => { console.error(err); process.exit(1); });
