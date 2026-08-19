'use strict';

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return {};
    return originalLoad.apply(this, arguments);
};
const { WolframMCPServer } = require('../../claude-mcp/server');
Module._load = originalLoad;

(async () => {
    const server = new WolframMCPServer(new Map(), [], { waitMs: 20, leaseMs: 20 });

    // Transport expiry only forgets its waiter; it has no abort authority.
    let abortCalled = false;
    server.abort = () => { abortCalled = true; };
    server._operations.set('expiry-op', { id: 'expiry-op', status: 'pending', leaseTimer: null });
    await server._expireOperation('expiry-op');
    assert.strictEqual(server._operations.has('expiry-op'), false);
    assert.strictEqual(abortCalled, false);

    // A transport operation is a UUID capability, not tied to its old SSE session.
    const settled = { id: 'cross-session', sessionId: 'old-session', status: 'fulfilled', result: { ok: true }, leaseTimer: null };
    server._operations.set(settled.id, settled);
    assert.deepStrictEqual(await server._waitEvaluation({ operation_id: settled.id }, 'fresh-session'), { ok: true });

    // The same UUID is injected into the execution layer at dispatch.
    let dispatchedId;
    server._dispatch = async (_method, params) => {
        dispatchedId = params.arguments._operationId;
        return { content: [{ type: 'text', text: 'done' }], isError: false };
    };
    await server._runManagedToolCall({ name: 'wolfbook_runCell', arguments: {} }, 'session-a');
    assert.match(dispatchedId, /^[0-9a-f-]{36}$/);

    // A fresh untargeted session discovers an execution UUID on worker windows.
    const discovery = new WolframMCPServer(new Map(), []);
    discovery._ownClientId = 'primary';
    discovery._workers.set('worker-a', { port: 30101 });
    discovery._workers.set('worker-b', { port: 30102 });
    discovery._invokeLocalOperationStatus = async () => ({ content: [{ type: 'text', text: 'Unknown operation_id: durable-op' }] });
    const calls = [];
    discovery._invokeWorker = async (port, _name, args) => {
        calls.push({ port, wait: args.wait_seconds });
        if (port === 30101) return { content: [{ type: 'text', text: 'Unknown operation_id: durable-op' }], isError: false };
        return { content: [{ type: 'text', text: JSON.stringify({ operation_id: 'durable-op', state: args.wait_seconds ? 'completed' : 'running' }) }], isError: false };
    };
    const found = await discovery._waitEvaluation({ operation_id: 'durable-op' }, 'new-session');
    assert(found.content[0].text.includes('completed'));
    assert.deepStrictEqual(calls, [
        { port: 30101, wait: 0 }, { port: 30102, wait: 0 }, { port: 30102, wait: 300 }
    ]);

    // operationStatus has the same reconnect semantics: its UUID discovers the
    // owning window even when the fresh SSE session has no notebook target.
    calls.length = 0;
    const status = await discovery._operationStatus({
        operation_id: 'durable-op', include_progress: true, wait_seconds: 7
    }, 'another-new-session');
    assert(status.content[0].text.includes('completed'));
    assert.deepStrictEqual(calls, [
        { port: 30101, wait: 0 }, { port: 30102, wait: 0 }, { port: 30102, wait: 7 }
    ]);

    // Client discovery normalizes duplicate paths, and a new registration
    // generation atomically replaces stale details for the same client ID.
    const clients = new WolframMCPServer(new Map(), []);
    clients.setOwnClientInfo('primary', ['/Tmp/A.wb', '/tmp/a.wb/', '/tmp/B.wb']);
    // registeredAt must be fresh: _buildClientList now prunes workers whose
    // heartbeat is stale (dead windows used to stay listed forever).
    const regAt = Date.now();
    clients._workers.set('worker', {
        port: 31001, pid: process.pid, notebooks: ['C:\\Work\\N.wb', 'c:/work/n.wb'],
        generation: 'new-host', registeredAt: regAt
    });
    const listed = clients._buildClientList();
    assert.deepStrictEqual(listed[0].notebooks, ['/Tmp/A.wb', '/tmp/B.wb']);
    assert.deepStrictEqual(listed[1].notebooks, ['C:\\Work\\N.wb']);
    assert.strictEqual(listed[1].generation, 'new-host');
    assert.strictEqual(listed[1].registeredAt, regAt);

    // A worker with a stale heartbeat is pruned from the client list.
    clients._workers.set('ghost', {
        port: 31002, pid: process.pid, notebooks: [], generation: 'old', registeredAt: 123
    });
    assert.strictEqual(clients._buildClientList().some(c => c.clientId === 'ghost'), false);
    assert.strictEqual(clients._workers.has('ghost'), false);

    // Target selection captures the notebook→kernel triple. Rebinding later is
    // observable, so the next routed call can reject rather than silently follow.
    clients.setKernelProvider(() => [{
        kernel_id: 'k-one', kernel_label: 'K1', lifecycle: 'idle', notebooks: ['/tmp/B.wb']
    }]);
    const targetReply = clients._handleSetTarget({ client_id: 'primary', notebook: 'B.wb' }, 'kernel-session');
    assert(targetReply.content[0].text.includes('k-one'));
    assert.strictEqual(clients._sessionTargets.get('kernel-session').kernelId, 'k-one');
    clients.setKernelProvider(() => [{
        kernel_id: 'k-two', kernel_label: 'K2', lifecycle: 'idle', notebooks: ['/tmp/B.wb']
    }]);
    assert.strictEqual(clients._resolveNotebookKernel('primary', 'B.wb').kernel_id, 'k-two');

    const bounded = new WolframMCPServer(new Map(), [], { boundedResults: true, resultThreshold: 4096 });
    const wrapped = bounded._boundResult({ content: [{ type: 'text', text: 'z'.repeat(5000) }], isError: false }, 'large-read', 'k-bounded');
    const envelope = JSON.parse(wrapped.content[0].text);
    assert.strictEqual(envelope.truncated, true);
    assert.strictEqual(envelope.kernel_id, 'k-bounded');
    assert.strictEqual(bounded._resultStore.get(envelope.result_handle, 4090, 20).data.length, 20);

    console.log('transport operation tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
