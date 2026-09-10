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

    // JSON-RPC cancellation must abort the execution UUID already dispatched
    // for that request. Background operations remain intentionally detached.
    const cancelling = new WolframMCPServer(new Map(), [], { waitMs: 1000, leaseMs: 1000 });
    let finishOriginal;
    const cancelCalls = [];
    cancelling._dispatch = async (_method, params) => {
        if (params.name === 'wolfbook_cancelOperation') {
            cancelCalls.push(params.arguments);
            return { content: [{ type: 'text', text: 'cancelled' }], isError: false };
        }
        return new Promise(resolve => { finishOriginal = resolve; });
    };
    const running = cancelling._runManagedToolCall(
        { name: 'wolfbook_runCell', arguments: { client_id: 'primary', kernel_id: 'k-3' } },
        'cancel-session', 41
    );
    await new Promise(resolve => setImmediate(resolve));
    const cancelled = await cancelling._cancelManagedRequest('cancel-session', 41, 'permission rejected');
    assert(cancelled);
    assert.strictEqual(cancelCalls.length, 1);
    assert.match(cancelCalls[0].operation_id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(cancelCalls[0].client_id, 'primary');
    assert.strictEqual(cancelCalls[0].kernel_id, 'k-3');
    assert.strictEqual(cancelCalls[0].reason, 'permission rejected');
    finishOriginal({ content: [{ type: 'text', text: 'aborted' }], isError: false });
    await running;

    const detached = new WolframMCPServer(new Map(), [], { waitMs: 1000, leaseMs: 1000 });
    let finishDetached;
    detached._dispatch = async () => new Promise(resolve => { finishDetached = resolve; });
    const background = detached._runManagedToolCall(
        { name: 'wolfbook_runCell', arguments: { wait_mode: 'async' } }, 'background-session', 'bg-1'
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(await detached._cancelManagedRequest('background-session', 'bg-1', 'disconnect'), false);
    finishDetached({ content: [{ type: 'text', text: 'accepted' }], isError: false });
    await background;

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
    const notebookNotices = [];
    const clients = new WolframMCPServer(new Map(), [], {
        notebookNotifier: event => notebookNotices.push(event),
    });
    clients.setOwnClientInfo('primary', ['/Tmp/A.wb', '/tmp/a.wb/', '/tmp/B.wb'], 'Primary workspace');
    // registeredAt must be fresh: _buildClientList now prunes workers whose
    // heartbeat is stale (dead windows used to stay listed forever).
    const regAt = Date.now();
    clients._workers.set('worker', {
        port: 31001, pid: process.pid, notebooks: ['C:\\Work\\N.wb', 'c:/work/n.wb'],
        generation: 'new-host', registeredAt: regAt, workspace: 'Worker workspace'
    });
    const listed = clients._buildClientList();
    assert.deepStrictEqual(listed[0].notebooks, ['/Tmp/A.wb', '/tmp/B.wb']);
    assert.deepStrictEqual(listed[1].notebooks, ['C:\\Work\\N.wb']);
    assert.strictEqual(listed[1].generation, 'new-host');
    assert.strictEqual(listed[1].registeredAt, regAt);
    assert.strictEqual(listed[0].workspace, 'Primary workspace');
    assert.strictEqual(listed[1].workspace, 'Worker workspace');

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
    const targetEvents = [];
    clients._activity = { record: event => targetEvents.push(event) };
    clients._sessionClientNames.set('kernel-session', 'codex-mcp-client');
    const targetReply = clients._handleSetTarget({ client_id: 'primary', notebook: 'B.wb' }, 'kernel-session');
    assert(targetReply.content[0].text.includes('k-one'));
    assert.strictEqual(clients._sessionTargets.get('kernel-session').kernelId, 'k-one');
    assert.strictEqual(targetEvents[0].type, 'agent.target.changed');
    assert.strictEqual(targetEvents[0].workspace, 'Primary workspace');
    assert.strictEqual(targetEvents[0].payload.targetClientId, 'primary');
    assert.strictEqual(targetEvents[0].payload.targetWorkspace, 'Primary workspace');
    assert.deepStrictEqual(notebookNotices, [{ notebook: 'B.wb', kind: 'switched' }]);
    clients._handleSetTarget({ client_id: 'primary', notebook: 'B.wb' }, 'kernel-session');
    assert.strictEqual(notebookNotices.length, 1, 'reselecting the same notebook is not a switch');
    clients._sessions.set('kernel-session', {});
    clients._sessionConnectedAt.set('kernel-session', 12345);
    const liveSession = clients._buildSessionList()[0];
    assert.strictEqual(liveSession.agentName, 'codex-mcp-client');
    assert.strictEqual(liveSession.hostWorkspace, 'Primary workspace');
    assert.strictEqual(liveSession.targetClientId, 'primary');
    assert.strictEqual(liveSession.notebook, 'B.wb');

    // Two sessions may deliberately share a kernel, but it is never silent:
    // targeting warns and client discovery exposes the attachment count.
    clients._sessionClientNames.set('second-session', 'Roo Code');
    const sharedReply = clients._handleSetTarget({ client_id: 'primary', notebook: 'Other.wb' }, 'second-session');
    // Other.wb is not in the provider, so explicitly model another target on K1.
    clients._sessionTargets.set('second-session', {
        clientId: 'primary', notebook: 'Other.wb', kernelId: 'k-one', ts: Date.now()
    });
    const warnedReply = clients._handleSetTarget({ client_id: 'primary', notebook: 'B.wb', force: true }, 'third-session');
    assert.match(warnedReply.content[0].text, /also attached|share definitions/i);
    const sharedKernel = clients._buildClientList()[0].kernels[0];
    assert.strictEqual(sharedKernel.attached_sessions, 2);
    assert.strictEqual(sharedKernel.shared_by_multiple_sessions, true);
    assert(sharedReply);
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

    // Canonical MCP responses keep JSON out of duplicate text blocks while
    // retaining it under structuredContent.
    const canonical = bounded._finalizeToolResult({ content: [{ type: 'text', text: JSON.stringify({
        ok: true, state: 'completed', message: 'Found two cells.', notebook_revision: 7,
        match_count: 2
    }) }], isError: false }, 'wolfbook_searchCells', 's');
    assert.strictEqual(canonical.content[0].text, 'Found two cells.');
    assert.strictEqual(canonical.structuredContent.data.match_count, 2);
    assert.strictEqual(canonical.structuredContent.notebookRevision, 7);

    // Explicit notebook resolution is deterministic and detects duplicate
    // basenames rather than silently following a sticky target.
    clients._ownNotebooks = ['/tmp/one/Same.wb'];
    clients._workers.set('worker-two', { port: 31003, pid: process.pid,
        notebooks: ['/tmp/two/Same.wb'], registeredAt: Date.now() });
    assert.strictEqual(clients._findClientsByNotebook('/tmp/one/Same.wb').length, 1);
    assert.strictEqual(clients._findClientsByNotebook('Same.wb').length, 2);

    console.log('transport operation tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
