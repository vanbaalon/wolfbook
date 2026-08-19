'use strict';

// Phase 5.3: renderJournalDigest — compact, memory-only session summary.

const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');

const { renderJournalDigest } = withVscodeStub(() => require('../../tools/index'));

const controller = {
    kernelIdentity: { label: 'K2', kernel_id: 'k-6657b737' },
    arbiter: { status: () => ({ lifecycle: 'idle', queueDepth: 0 }) },
    operations: {
        hasRestarted: false,
        journal: () => [
            { operation_id: 'bbbb2222-0000-0000-0000-000000000000', tool: 'wolfbook_evaluateExpression',
              caption: 'check residual', state: 'failed', started_at: '2026-08-18T12:03:02.000Z',
              elapsed_ms: 100, notebook: '/tmp/proto2.wb', error: 'Power::infy',
              assertion: { outcome: 'FAIL' }, cells: [] },
            { operation_id: 'aaaa1111-0000-0000-0000-000000000000', tool: 'wolfbook_runCell',
              caption: 'Solve the ODE', state: 'completed', started_at: '2026-08-18T12:04:11.000Z',
              elapsed_ms: 1200, notebook: '/tmp/proto2.wb', result_preview: 'y[x] -> ...',
              assertion: { outcome: 'PASS' }, cells: [{ status: 'success-with-output' }] },
        ],
    },
};

const digest = renderJournalDigest(controller);
const lines = digest.split('\n');

assert.match(lines[0], /Kernel K2 k-6657b737 · idle · 2 operation\(s\) retained/);
assert.match(digest, /Notebooks touched: proto2\.wb \(2 ops\)/);
assert.match(digest, /✗ 12:03:02.*check residual.*ASSERT FAIL/);
assert.match(digest, /✓ 12:04:11.*Solve the ODE.*ASSERT PASS/);
assert.match(digest, /Failures: 1 · Assertions: 1 pass \/ 1 fail · Aborts: 0/);
assert.match(digest, /Latest error: Power::infy \(operation bbbb2222…\)/);
assert.ok(lines.length <= 20, `digest must stay compact (${lines.length} lines)`);

// Restarted kernel gets the invalidation note.
const restarted = { ...controller, operations: { ...controller.operations, hasRestarted: true } };
assert.match(renderJournalDigest(restarted), /kernel restarted this session/);

// Empty journal renders without throwing.
const empty = renderJournalDigest({ operations: { journal: () => [] } });
assert.match(empty, /0 operation\(s\) retained/);

console.log('journal-digest tests: OK');
