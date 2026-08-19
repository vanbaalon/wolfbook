'use strict';

// wolfbook_selfTest — end-to-end MCP self-check (feedback 2026-08-18 §5).
//
// Exercises the REAL registered tool delegates (via a lazy accessor to the
// finished tool map), so it tests exactly what an agent calls: create a temp
// notebook, run a cell, verify the symbol landed in the kernel, check the save
// round trip, clean up — pass/fail per stage.  The phantom-run bug fails the
// `association` and `kernel-visible` stages; the registry bug fails
// `operation-resolution`; a save regression fails `save-integrity`.
//
// MUST NOT take its own arbiter lease: every tool it invokes takes one, and a
// self-held lease would deadlock them (arbiter.acquire returns busy).  Also
// deliberately not in the invoke wrapper's operationTools set.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const _token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };

function _text(result) {
    return (result?.content || []).map(p => String(p?.value ?? p?.text ?? '')).join('\n');
}

class SelfTestTool {
    constructor(getController, getToolMap) {
        this._getController = getController;
        this._getToolMap = getToolMap;
    }

    async prepareInvocation(options, _t) {
        return { invocationMessage: `Wolfbook MCP self-test (${options.input?.scope || 'quick'})` };
    }

    async invoke(options, _t) {
        const scope = options.input?.scope === 'full' ? 'full' : 'quick';
        const keepArtifacts = options.input?.keepArtifacts === true;
        const stages = [];
        const run = async (name, only, fn) => {
            if (only === 'full' && scope !== 'full') {
                stages.push({ name, status: 'skip', detail: 'full scope only', elapsedMs: 0 });
                return null;
            }
            const t0 = Date.now();
            try {
                const detail = await fn();
                stages.push({ name, status: 'pass', detail: String(detail || 'ok').slice(0, 200), elapsedMs: Date.now() - t0 });
                return detail;
            } catch (err) {
                stages.push({ name, status: 'fail', detail: String(err.message || err).slice(0, 300), elapsedMs: Date.now() - t0 });
                return null;
            }
        };
        const tools = this._getToolMap?.();
        if (!tools) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Self-test unavailable: tool map not initialised.')]);
        }
        const call = async (name, input) => {
            const impl = tools.get(name);
            if (!impl) throw new Error(`tool ${name} is not registered`);
            const result = await impl.invoke({ input, skipConfirm: true }, _token);
            return _text(result);
        };

        const ts = Date.now().toString(36);
        const sym = `wbSelfTest$${ts}`;
        const nbPath = path.join(os.tmpdir(), `wolfbook-selftest-${ts}.wb`);
        let opId = null;

        // 1. resolve — a kernel controller must be reachable.
        const controller = await run('resolve', null, async () => {
            const ctrl = this._getController?.({});
            if (!ctrl) throw new Error('no kernel controller resolved');
            const status = ctrl.arbiter?.status?.(ctrl);
            return `kernel ${ctrl.kernelIdentity?.label || '?'} ${ctrl.kernelIdentity?.kernel_id || ''} · ${status?.lifecycle || ctrl.kernelStatusString}`;
        }) && this._getController?.({});

        // 2. kernel round trip.
        await run('kernel-roundtrip', null, async () => {
            const out = await call('wolfbook_evaluateExpression', { expression: '1 + 1', timeoutSeconds: 20 });
            if (!/Out=\s*2\b/.test(out)) throw new Error(`1+1 did not return 2: ${out.slice(0, 120)}`);
            return '1+1 → 2';
        });

        // 3. notebook create.
        await run('notebook-create', null, async () => {
            const out = await call('wolfbook_newNotebook', { path: nbPath, target: false });
            if (!/Created and opened|Opened existing/.test(out)) throw new Error(out.slice(0, 200));
            return out.split('\n').find(l => l.startsWith('Kernel:')) || 'created';
        });

        // 4. association — the direct phantom-run guard.
        await run('association', null, async () => {
            const { isAssociated } = require('../kernel/association');
            const doc = vscode.workspace.notebookDocuments.find(d => d.uri.fsPath === nbPath);
            if (!doc) throw new Error('notebook document not found after create');
            const ctrl = this._getController?.({ notebook: nbPath });
            if (!ctrl) throw new Error('no controller for the new notebook');
            if (!isAssociated(ctrl, doc)) throw new Error('controller NOT selected for the new notebook — first runs would be silently dropped');
            return 'controller selected';
        });

        // 5. cell execute with evidence.
        await run('cell-execute', null, async () => {
            const out = await call('wolfbook_insertCells', {
                notebook: path.basename(nbPath), kind: 'code', content: `${sym} = 6*7`,
                evaluate: true, timeoutSeconds: 30,
            });
            opId = (out.match(/Operation ID: ([0-9a-f-]{36})/) || [])[1] || null;
            if (/dispatched-unconfirmed|NOT executed|not-dispatched/i.test(out)) {
                throw new Error(`evaluation not confirmed: ${out.slice(0, 200)}`);
            }
            if (!/✓/.test(out)) throw new Error(`no evidence-backed ✓ in response: ${out.slice(0, 200)}`);
            return `cell ran (${opId ? `op ${opId.slice(0, 8)}…` : 'no op id'})`;
        });

        // 6. kernel visible — proves the cell reached THIS kernel.
        await run('kernel-visible', null, async () => {
            const out = await call('wolfbook_evaluateExpression', { expression: sym, timeoutSeconds: 20 });
            if (!/Out=\s*42\b/.test(out)) throw new Error(`symbol did not land in the kernel: ${out.slice(0, 120)}`);
            return `${sym} → 42`;
        });

        // 7. edit + rerun (full).
        await run('edit-rerun', 'full', async () => {
            const ctx = await call('wolfbook_getNotebookContext', { notebook: path.basename(nbPath) });
            const cellId = (ctx.match(/[Cc]ellId:\s*([A-Za-z0-9%_=-]+)/) || [])[1];
            if (!cellId) throw new Error('could not extract a CellId');
            const out = await call('wolfbook_editCell', {
                notebook: path.basename(nbPath), cellId, content: `${sym} = 6*8`, evaluate: true, timeoutSeconds: 30,
            });
            if (/ASSERT FAIL|failed/i.test(out) && !/✓/.test(out)) throw new Error(out.slice(0, 200));
            const check = await call('wolfbook_evaluateExpression', { expression: sym, timeoutSeconds: 20 });
            if (!/Out=\s*48\b/.test(check)) throw new Error(`edited value did not land: ${check.slice(0, 120)}`);
            return 'edit re-evaluated, new value visible';
        });

        // 8. save integrity — SHA-256 must match the file on disk.
        await run('save-integrity', null, async () => {
            const out = await call('wolfbook_saveNotebook', { notebook: path.basename(nbPath) });
            const reported = (out.match(/"sha256":\s*"([0-9a-f]{64})"/) || [])[1];
            if (!reported) throw new Error(`no sha256 in save response: ${out.slice(0, 200)}`);
            const actual = crypto.createHash('sha256').update(fs.readFileSync(nbPath)).digest('hex');
            if (reported !== actual) throw new Error(`sha mismatch: reported ${reported.slice(0, 12)}…, disk ${actual.slice(0, 12)}…`);
            return `sha256 verified (${reported.slice(0, 12)}…)`;
        });

        // 9. journal has per-cell provenance for the run.
        await run('journal', null, async () => {
            // The journal is kernel-scoped: on a window with remote kernel proxies
            // attached, calling without kernel_id throws the multi-kernel guard —
            // pass the kernel this self-test resolved in stage 1.
            const kernelId = controller?.kernelIdentity?.kernel_id;
            const out = await call('wolfbook_evaluationJournal', {
                limit: 10, ...(kernelId ? { kernel_id: kernelId } : {}),
            });
            let journal;
            try { journal = JSON.parse(out); } catch (_) { throw new Error(`journal is not JSON: ${out.slice(0, 120)}`); }
            const ops = Array.isArray(journal) ? journal : journal.operations || [];
            const withCells = ops.find(op => Array.isArray(op.cells) && op.cells.length > 0);
            if (!withCells) throw new Error('no journal entry carries per-cell provenance (cells:[]) — the phantom-run signature');
            return `provenance present (op ${String(withCells.operation_id).slice(0, 8)}…)`;
        });

        // 10. operation resolution WITHOUT kernel_id.
        await run('operation-resolution', null, async () => {
            if (!opId) throw new Error('no operation id captured in cell-execute');
            const out = await call('wolfbook_operationStatus', { operation_id: opId });
            if (/kernel_id is required/i.test(out)) throw new Error('operationStatus demanded kernel_id — op-id resolution regressed');
            if (/Unknown operation_id/i.test(out)) throw new Error(`operation not found: ${opId}`);
            return 'resolved by operation id alone';
        });

        // 11. cleanup.
        await run('cleanup', null, async () => {
            if (keepArtifacts) return `kept ${nbPath}`;
            await call('wolfbook_evaluateExpression', { expression: `ClearAll["Global\`${sym}"]`, timeoutSeconds: 10 }).catch(() => {});
            const doc = vscode.workspace.notebookDocuments.find(d => d.uri.fsPath === nbPath);
            if (doc) {
                try {
                    await vscode.window.showNotebookDocument(doc, { preserveFocus: true });
                    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                } catch (_) {}
            }
            try { fs.unlinkSync(nbPath); } catch (_) {}
            const imgDir = path.join(path.dirname(nbPath), 'img', path.basename(nbPath, '.wb'));
            try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (_) {}
            return 'temp notebook removed';
        });

        const failed = stages.filter(s => s.status === 'fail');
        const overall = failed.length ? 'FAIL' : 'PASS';
        const table = stages.map(s =>
            `${s.status === 'pass' ? '✓' : s.status === 'fail' ? '✗' : '·'} ${s.name.padEnd(20)} ${String(s.elapsedMs).padStart(6)} ms  ${s.detail}`);
        const summary = [
            `Wolfbook MCP self-test: ${overall} (${stages.filter(s => s.status === 'pass').length} pass / ${failed.length} fail / ${stages.filter(s => s.status === 'skip').length} skip)`,
            ...table,
            '',
            JSON.stringify({ overall, scope, stages }, null, 2),
        ].join('\n');
        const result = new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary)]);
        if (failed.length) result.isError = true;
        return result;
    }
}

module.exports = { SelfTestTool };
