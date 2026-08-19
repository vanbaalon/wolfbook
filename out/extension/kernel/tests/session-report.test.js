'use strict';
const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');
const { renderSessionReport } = withVscodeStub(() => require('../../tools/index'));

const journal = [
    { operation_id: 'op-1', tool: 'wolfbook_runCell', caption: 'build artifact', state: 'completed',
      started_at: '2026-08-19T10:00:00.000Z', elapsed_ms: 12, notebook: '/tmp/a.wb',
      result_preview: 'Saved /tmp/results/data.json sha256 ' + 'a'.repeat(64) },
    { operation_id: 'op-2', tool: 'wolfbook_evaluateExpression', caption: 'bad check', state: 'failed',
      started_at: '2026-08-19T10:01:00.000Z', elapsed_ms: 5, notebook: '/tmp/a.wb', error: 'Power::infy', result_preview: '1/0' },
    { operation_id: 'op-3', tool: 'wolfbook_runCell', caption: 'cancelled', state: 'aborted',
      started_at: '2026-08-19T10:02:00.000Z', elapsed_ms: 8, cancellation: { reason: 'user' } },
];
const controller = { kernelIdentity: { label: 'K1', kernel_id: 'k-1' },
    arbiter: { status: () => ({ lifecycle: 'idle' }) }, operations: { hasRestarted: true } };
const report = renderSessionReport(controller, { journal });
assert.match(report, /^# Wolfbook session report/);
assert.match(report, /## Operations/);
assert.match(report, /Power::infy/);
assert.match(report, /Aborted \/ abandoned/);
assert.match(report, /\/tmp\/results\/data\.json/);
assert.match(report, new RegExp('a{64}'));
assert.match(report, /kernel restarted/);
console.log('session-report tests: OK');
