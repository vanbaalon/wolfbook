'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ActivityMonitor, sanitize, runWithActivityContext } = require('../../monitor/activity');
const { compactDiff } = require('../../monitor/notebook-audit');

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
    const dashboard = await request(monitor.port, '/monitor/', { headers: { Cookie: cookie } });
    assert.strictEqual(dashboard.status, 200);
    assert.match(dashboard.body, /Wolfbook MCP Control Room/);
    assert.match(dashboard.body, /Connected via/);
    assert.match(dashboard.body, /No VS Code target selected yet/);
    assert.doesNotMatch(dashboard.body, /@keyframes|animation:/, 'control room must not contain continuous animation');
    assert.doesNotMatch(dashboard.body, /class="progress"/, 'live cards must not use decorative progress bars');
    assert.match(dashboard.headers['content-security-policy'], /default-src 'self'/);
    const events = await request(monitor.port, '/monitor/api/events?since=0', { headers: { Cookie: cookie } });
    assert.strictEqual(events.status, 200);
    assert.strictEqual(JSON.parse(events.body).events[0].operationId, 'op-1');
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
