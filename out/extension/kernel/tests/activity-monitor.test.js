'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ActivityMonitor, sanitize, runWithActivityContext } = require('../../monitor/activity');
const { compactDiff } = require('../../monitor/notebook-audit');
const { projectActivity } = require('../../monitor/activity-projection');

function request(port, pathname, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: pathname,
            method: options.method || 'GET', headers: options.headers || {} }, res => {
            let body = ''; res.on('data', d => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject); req.end(options.body || undefined);
    });
}

(async () => {
    const safe = sanitize({ password: 'unsafe', api_key: 'unsafe', image: 'data:image/png;base64,' + 'A'.repeat(500),
        encoded: { content_encoding: 'base64', content: 'A'.repeat(1024) }, nested: { ok: 'yes' } });
    assert.strictEqual(safe.password, '[redacted]');
    assert.strictEqual(safe.api_key, '[redacted]');
    assert.match(safe.image, /binary data omitted/);
    assert.match(safe.encoded.content, /base64 content omitted/);
    assert.strictEqual(safe.nested.ok, 'yes');

    assert.deepStrictEqual(compactDiff('abc OLD xyz', 'abc NEW xyz'), {
        prefixLength: 4, suffixLength: 4, removed: 'OLD', added: 'NEW', removedLength: 3, addedLength: 3,
    });

    const projection = projectActivity([
        { eventId: 's1', timestamp: 100, type: 'tool.started', operationId: 'call-1', agentSessionId: 'session-abcdef', agentName: 'Roo Code', source: 'mcp', notebook: '/tmp/work.wb', kernelId: 'k3', payload: { tool: 'wolfbook_runCell', input: { cellNumber: 7 } }, state: 'running' },
        { eventId: 's2', timestamp: 110, type: 'notebook.cell.edited', operationId: 'call-1', agentSessionId: 'session-abcdef', agentName: 'Roo Code', source: 'mcp', notebook: '/tmp/work.wb', payload: { action: 'edit', cellNumber: 7 }, state: 'completed' },
        { eventId: 's3', timestamp: 140, type: 'tool.completed', operationId: 'call-1', agentSessionId: 'session-abcdef', agentName: 'Roo Code', source: 'mcp', notebook: '/tmp/work.wb', kernelId: 'k3', payload: { tool: 'wolfbook_runCell', output: { ok: true }, durationMs: 40 }, state: 'completed' },
        { eventId: 's4', timestamp: 150, type: 'kernel.topology', source: 'vscode', clientId: 'VSCode[Test]', payload: { kernels: [] }, state: 'observed' },
    ], { sessions: [{ sessionId: 'session-abcdef', agentName: 'Roo Code', profile: 'economy' }] });
    assert.strictEqual(projection.operations.length, 1, 'one operation should represent its whole lifecycle');
    assert.strictEqual(projection.operations[0].actor.label, 'Roo Code · sessio');
    assert.deepStrictEqual(projection.operations[0].input, { cellNumber: 7 });
    assert.deepStrictEqual(projection.operations[0].output, { ok: true });
    assert.strictEqual(projection.operations[0].changes.length, 1);
    assert.strictEqual(projection.diagnostics.length, 1, 'topology stays out of human work');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-monitor-test-'));
    const monitor = new ActivityMonitor({ storageDir: dir });
    monitor.setClientInfo('VSCode[Test]', 'Test workspace');
    monitor.setPrimary(true);
    runWithActivityContext({ operationId: 'op-1', agentName: 'test-agent', source: 'mcp' }, () => {
        monitor.record({ type: 'notebook.cell.edited', notebook: '/tmp/test.wb', state: 'completed', payload: { cellId: 'c1' } });
    });
    await monitor.writeChain;
    assert.strictEqual(monitor.events.length, 1);
    assert.strictEqual(monitor.events[0].operationId, 'op-1');
    assert.strictEqual(monitor.events[0].agentName, 'test-agent');
    const journal = fs.readFileSync(path.join(dir, 'monitor', 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    assert.match(journal, /notebook\.cell\.edited/);

    const server = http.createServer((req, res) => monitor.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    monitor.setPort(server.address().port);

    const locked = await request(monitor.port, '/monitor/');
    assert.strictEqual(locked.status, 403);
    const launchUrl = await monitor.createLaunchUrl();
    const launchPath = new URL(launchUrl).pathname;
    const launched = await request(monitor.port, launchPath);
    assert.strictEqual(launched.status, 302);
    assert.strictEqual(launched.headers.location, '/monitor/');
    assert.match(launched.headers['set-cookie'][0], /HttpOnly/);
    const cookie = launched.headers['set-cookie'][0].split(';')[0];
    monitor.setActionHandler(async action => ({ ok: true, action: action.action }));
    const dashboard = await request(monitor.port, '/monitor/', { headers: { Cookie: cookie } });
    assert.strictEqual(dashboard.status, 200);
    assert.match(dashboard.body, /Wolfbook Activity/);
    assert.match(dashboard.body, />Now</);
    assert.match(dashboard.body, />Recent work</);
    assert.match(dashboard.body, />Diagnostics</);
    assert.doesNotMatch(dashboard.body, /data-view="agents"|data-view="kernels"|data-view="notebooks"/, 'entity tabs were replaced by one workspace');
    assert.doesNotMatch(dashboard.body, /data-detail="input"|data-detail="output"|data-detail="raw"/, 'detail tabs were replaced by contextual sections');
    assert.doesNotMatch(dashboard.body, /@keyframes|animation:/, 'control room must not contain continuous animation');
    assert.doesNotMatch(dashboard.body, /class="progress"/, 'live cards must not use decorative progress bars');
    assert.match(dashboard.headers['content-security-policy'], /default-src 'self'/);
    const events = await request(monitor.port, '/monitor/api/events?since=0', { headers: { Cookie: cookie } });
    assert.strictEqual(events.status, 200);
    assert.strictEqual(JSON.parse(events.body).events[0].operationId, 'op-1');
    const overview = await request(monitor.port, '/monitor/api/overview?since=0', { headers: { Cookie: cookie } });
    assert.strictEqual(overview.status, 200);
    assert.strictEqual(JSON.parse(overview.body).operations.length, 1);
    const blockedAction = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ action: 'open' }),
    });
    assert.strictEqual(blockedAction.status, 403, 'control actions require the explicit same-page header');
    const action = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie, 'X-Wolfbook-Action': '1' }, body: JSON.stringify({ action: 'open', id: 'op-1' }),
    });
    assert.strictEqual(action.status, 200);
    assert.strictEqual(JSON.parse(action.body).action, 'open');
    let openedChange;
    monitor.setActionHandler(async value => { openedChange = value; return { ok: true }; });
    const cellAction = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie, 'X-Wolfbook-Action': '1' },
        body: JSON.stringify({ action: 'open', id: 'op-1', changeIndex: 0, cellId: 'forged' }),
    });
    assert.strictEqual(cellAction.status, 200, cellAction.body);
    assert.strictEqual(openedChange.cellId, 'c1', 'cell target must come from the recorded change');
    const invalidChange = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie, 'X-Wolfbook-Action': '1' },
        body: JSON.stringify({ action: 'abort', id: 'op-1', changeIndex: 0 }),
    });
    assert.strictEqual(invalidChange.status, 400);
    const malformed = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie, 'X-Wolfbook-Action': '1' }, body: '{',
    });
    assert.strictEqual(malformed.status, 400);

    // More than sanitize()'s generic array cap must remain accessible, including
    // operations restored only from an older journal after extension reload.
    const oldTime = Date.now() - 2 * 86400000;
    const older = Array.from({ length: 520 }, (_, i) => ({ eventId: `old-${i}`, operationId: `old-${i}`,
        timestamp: oldTime + i, type: 'tool.completed', state: 'completed', clientId: 'VSCode[Test]',
        source: 'mcp', agentName: 'Roo Code', payload: { tool: 'wolfbook_getNotebookContext', input: { cellNumber: i } } }));
    fs.writeFileSync(path.join(dir, 'monitor', 'events', `${new Date(oldTime).toISOString().slice(0, 10)}.jsonl`), older.map(e => JSON.stringify(e)).join('\n') + '\n');
    const page = JSON.parse((await request(monitor.port, '/monitor/api/overview?since=0&limit=500', { headers: { Cookie: cookie } })).body);
    assert.strictEqual(page.operations.length, 500);
    assert.strictEqual(page.hasMore, true);
    const all = JSON.parse((await request(monitor.port, '/monitor/api/overview?since=0&limit=1000', { headers: { Cookie: cookie } })).body);
    assert.strictEqual(all.operations.length, 521);
    assert.strictEqual(all.hasMore, false);
    const oldAction = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie, 'X-Wolfbook-Action': '1' }, body: JSON.stringify({ action: 'open', id: 'old-0' }),
    });
    assert.strictEqual(oldAction.status, 200);

    const owner = new ActivityMonitor({ storageDir: dir });
    owner.setClientInfo('VSCode[Owner]', 'Owner workspace');
    let received;
    owner.setActionHandler(async action => { received = action; return { ok: true }; });
    const ownerServer = http.createServer((req, res) => owner.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise(resolve => ownerServer.listen(0, '127.0.0.1', resolve));
    monitor.setTopologyProvider(() => ({ clients: [{ clientId: 'VSCode[Owner]', workerPort: ownerServer.address().port }] }));
    monitor.record({ operationId: 'remote-op', clientId: 'VSCode[Owner]', type: 'tool.completed', state: 'completed', notebook: '/tmp/owner.wb', payload: { tool: 'wolfbook_editCell', cellId: 'actual-cell' } });
    const routed = await request(monitor.port, '/monitor/api/action', {
        method: 'POST', headers: { Cookie: cookie, 'X-Wolfbook-Action': '1' },
        body: JSON.stringify({ action: 'open', id: 'remote-op', notebook: '/tmp/untrusted.wb', cellId: 'wrong-cell' }),
    });
    assert.strictEqual(routed.status, 200, routed.body);
    assert.strictEqual(received.clientId, 'VSCode[Owner]');
    assert.strictEqual(received.notebook, '/tmp/owner.wb');
    assert.strictEqual(received.cellId, 'actual-cell');
    const forbiddenInternal = await request(ownerServer.address().port, '/monitor/internal/action', {
        method: 'POST', body: JSON.stringify({ action: 'open', clientId: 'VSCode[Owner]' }),
    });
    assert.strictEqual(forbiddenInternal.status, 403);
    await monitor.writeChain;
    await new Promise(resolve => ownerServer.close(resolve));
    monitor.setTopologyProvider(() => ({
        clients: [{ clientId: 'VSCode[Test]', workspace: 'Test workspace' }],
        sessions: [{ sessionId: 'live-session', hostClientId: 'VSCode[Test]', hostWorkspace: 'Test workspace' }],
    }));
    const topology = await request(monitor.port, '/monitor/api/topology', { headers: { Cookie: cookie } });
    assert.strictEqual(JSON.parse(topology.body).clients[0].workspace, 'Test workspace');
    assert.strictEqual(JSON.parse(topology.body).sessions[0].sessionId, 'live-session');
    const reused = await request(monitor.port, launchPath);
    assert.strictEqual(reused.status, 403, 'launch nonce must be one-time');

    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('activity monitor tests: OK');
})().catch(error => { console.error(error); process.exit(1); });
