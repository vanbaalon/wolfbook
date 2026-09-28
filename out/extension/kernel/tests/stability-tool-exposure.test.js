'use strict';

// Stability: the MCP tool surface — popular tools always listed, rare ones
// revealed on demand — driven through the REAL HTTP/SSE handler with the real
// package.json schemas. Each block is a behaviour that was missing or broken
// before the 2026-09-25 audit (Internal Docs/misc/MCP_TOOL_AUDIT_2026-09-25.md):
//
//   * every client got all ~80 tools (~35 k tokens) whether it used them or not;
//   * there was no way to reveal a tool later, no tools/list_changed, and the
//     stdio bridge dropped server notifications anyway;
//   * slide/paper tools were listed with no deck or paper open;
//   * client_id + kernel_id were injected into every tool (22 % of the payload);
//   * plain-text replies reached Claude Code as their FIRST LINE only;
//   * plain-text failures were reported ok:true;
//   * operationStatus could not resolve the server's own operation IDs;
//   * wolfbook_runTerminal / wolfbook_fileOps bypassed the host's permissions.

const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return {};
    return originalLoad.apply(this, arguments);
};
const { WolframMCPServer, loadMCPSchemas } = require('../../claude-mcp/server');
Module._load = originalLoad;

const schemas = loadMCPSchemas(path.join(__dirname, '..', '..', '..', '..', 'package.json'));
const text = t => ({ content: [{ value: t }] });
const tools = new Map([
    ['wolfbook_status', { invoke: async () => text('Clients:\n  VSCode[a] primary\nKernels:\n  K1 idle\nOperations: none') }],
    ['wolfslide_saveFile', { invoke: async () => text('Deck saved.') }],
    ['wolfbook_debugCell', { invoke: async () => text('No debug session.') }],
    ['wolfbook_kernelCrashLog', { invoke: async () => text('Unknown client: "VSCode[x]".') }],
    ['wolfbook_operationStatus', { invoke: async () => text('Unknown operation_id: nope') }],
]);

function sseClient(port, pathName) {
    return new Promise((resolve, reject) => {
        const events = []; const waiters = [];
        const req = http.get({ host: '127.0.0.1', port, path: pathName }, res => {
            let buf = ''; let endpoint = null;
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk; let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const ev = (block.match(/^event: (.*)$/m) || [])[1];
                    const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
                    if (ev === 'endpoint') { endpoint = data; resolve(client); continue; }
                    let msg; try { msg = JSON.parse(data); } catch { continue; }
                    events.push(msg);
                    for (const w of waiters.splice(0)) w();
                }
            });
            let nextId = 1;
            const client = {
                events, close: () => req.destroy(),
                async request(method, params = {}) {
                    const id = nextId++;
                    await post({ jsonrpc: '2.0', id, method, params });
                    return waitFor(m => m.id === id);
                },
                notified: (method, since) => waitFor(m => m.method === method && events.indexOf(m) >= since),
            };
            const post = body => new Promise((ok, bad) => {
                const b = JSON.stringify(body);
                const p = http.request({ host: '127.0.0.1', port, path: endpoint, method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
                    r => { r.resume(); r.on('end', ok); });
                p.on('error', bad); p.end(b);
            });
            const waitFor = (pred, ms = 3000) => new Promise((ok, bad) => {
                const timer = setTimeout(() => bad(new Error('timeout waiting for SSE message')), ms);
                const check = () => { const hit = events.find(pred); if (hit) { clearTimeout(timer); ok(hit); } else waiters.push(check); };
                check();
            });
        });
        req.on('error', reject);
    });
}

(async () => {
    const server = new WolframMCPServer(tools, schemas, { waitMs: 2000, initialWaitMs: 2000 });
    server._docContext = () => ({ slides: server._testSlides || false, paper: false });   // no vscode here
    const srv = http.createServer((req, res) => server._handle(req, res));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    try {
        const c = await sseClient(port, '/sse');
        const init = await c.request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'exposure-test' }, capabilities: {} });
        assert.strictEqual(init.result.capabilities.tools.listChanged, true, 'server announces tools/list_changed');

        // ---- 1. Default surface: popular tools only --------------------------------
        let list = (await c.request('tools/list')).result.tools;
        let names = new Set(list.map(t => t.name));
        for (const n of ['wolfbook_evaluateExpression', 'wolfbook_insertCells', 'wolfbook_getNotebookContext',
            'wolfbook_operationStatus', 'wolfbook_editCell', 'wolfbook_runCell', 'wolfbook_status',
            'wolfbook_tools', 'wolfbook_list_clients', 'wolfbook_setTarget', 'wolfbook_getResult']) {
            assert.ok(names.has(n), `popular/core tool listed: ${n}`);
        }
        for (const n of ['wolfbook_debugCell', 'wolfbook_selfTest', 'wolfslide_block', 'wolfteam_askDecision',
            'wolfbook_fairy_dispatch', 'paper_getSection', 'wolfbook_waitEvaluation', 'wolfbook_paperSearch']) {
            assert.ok(!names.has(n), `rare tool hidden by default: ${n}`);
        }
        for (const n of ['wolfslide_getSlideHtml', 'paper_search']) {
            assert.ok(!names.has(n), `context tool hidden with no deck/paper open: ${n}`);
        }
        assert.ok(!names.has('wolfbook_runTerminal') && !names.has('wolfbook_fileOps'), 'removed tools are gone');
        const bytes = Buffer.byteLength(JSON.stringify(list));
        assert.ok(list.length <= 25 && bytes < 45000, `default surface is small: ${list.length} tools, ${bytes} B`);
        const evalSchema = list.find(t => t.name === 'wolfbook_evaluateExpression').inputSchema.properties;
        assert.ok(evalSchema.client_id.description.length < 100, 'routing param description is short');
        assert.ok(evalSchema.kernel_id, 'kernel tools keep kernel_id');

        // ---- 2. Reveal on demand -------------------------------------------------------
        const cat = await c.request('tools/call', { name: 'wolfbook_tools', arguments: { action: 'list' } });
        assert.match(cat.result.structuredContent.text, /debug \[off\]/, 'catalogue lists families and state');
        let mark = c.events.length;
        const en = await c.request('tools/call', { name: 'wolfbook_tools', arguments: { action: 'enable', families: ['debug'] } });
        await c.notified('notifications/tools/list_changed', mark);
        assert.match(en.result.structuredContent.text, /wolfbook_debugCell\(/, 'enable replies with the new tools');
        names = new Set((await c.request('tools/list')).result.tools.map(t => t.name));
        assert.ok(names.has('wolfbook_debugCell') && names.has('wolfbook_selfTest'), 'enabled family is listed');
        assert.ok(!names.has('wolfteam_askDecision'), 'only the requested family');

        // call reaches a tool that is NOT listed — for clients that never refresh
        const viaCall = await c.request('tools/call', { name: 'wolfbook_tools',
            arguments: { action: 'call', name: 'wolfslide_saveFile', arguments: {} } });
        assert.strictEqual(viaCall.result.isError, false);
        assert.match(JSON.stringify(viaCall.result), /Deck saved/, 'call proxies to the real tool');
        assert.strictEqual(viaCall.result.structuredContent.tool, 'wolfslide_saveFile', 'proxied call is the direct call');

        // ---- 3. Reconnect keeps what the agent enabled ------------------------------------
        const c2 = await sseClient(port, '/sse');
        await c2.request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'exposure-test' }, capabilities: {} });
        names = new Set((await c2.request('tools/list')).result.tools.map(t => t.name));
        assert.ok(names.has('wolfbook_debugCell'), 'a reconnecting client keeps its enabled families');
        c2.close();

        mark = c.events.length;
        await c.request('tools/call', { name: 'wolfbook_tools', arguments: { action: 'disable', families: ['debug'] } });
        await c.notified('notifications/tools/list_changed', mark);
        names = new Set((await c.request('tools/list')).result.tools.map(t => t.name));
        assert.ok(!names.has('wolfbook_debugCell'), 'disable removes the family again');

        // ---- 4. Context: a deck opens in some window → slide tools appear -----------
        mark = c.events.length;
        server._testSlides = true;
        server._checkDocContext();
        await c.notified('notifications/tools/list_changed', mark);
        names = new Set((await c.request('tools/list')).result.tools.map(t => t.name));
        assert.ok(names.has('wolfslide_getSlideHtml') && names.has('wolfslide_patchBlock'), 'popular slide tools appear with a deck open');
        assert.ok(!names.has('wolfslide_block') && !names.has('wolfslide_undo'), 'rare slide tools stay on demand');
        const slideSchema = (await c.request('tools/list')).result.tools.find(t => t.name === 'wolfslide_patchBlock').inputSchema.properties;
        assert.ok(slideSchema.client_id && !slideSchema.kernel_id, 'slide tools do not get kernel_id');
        server._testSlides = false;
        server._checkDocContext();

        // ---- 5. Removed tools answer clearly ----------------------------------------------
        const removed = await c.request('tools/call', { name: 'wolfbook_runTerminal', arguments: { command: 'echo hi' } });
        assert.strictEqual(removed.result.isError, true);
        assert.match(JSON.stringify(removed.result), /own shell tool/);
        const removedViaCall = await c.request('tools/call', { name: 'wolfbook_tools',
            arguments: { action: 'call', name: 'wolfbook_fileOps', arguments: { action: 'read' } } });
        assert.strictEqual(removedViaCall.result.isError, true, 'wolfbook_tools cannot resurrect a removed tool');

        // ---- 6. Envelope: the body reaches whichever channel a client reads ----------------
        const status = await c.request('tools/call', { name: 'wolfbook_status', arguments: {} });
        assert.match(status.result.structuredContent.text, /K1 idle/, 'plain-text body is in structuredContent');
        // (the server prepends its own clients section as a separate part)
        assert.match(status.result.content.map(p => p.text).join('\n'), /K1 idle/, 'and in content');
        assert.ok(!('cells' in status.result.structuredContent) && !('remedy' in status.result.structuredContent),
            'empty envelope fields are dropped');
        const failure = await c.request('tools/call', { name: 'wolfbook_kernelCrashLog', arguments: {} });
        assert.strictEqual(failure.result.structuredContent.ok, false, 'a plain-text failure is not reported ok:true');

        // ---- 7. operationStatus resolves the server's own long-call IDs ------------------
        let finish;
        const op = { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'wolfbook_runCell', status: 'pending',
            leaseTimer: null, promise: new Promise(r => { finish = r; }), kernelId: null };
        server._operations.set(op.id, op);
        setTimeout(() => { op.status = 'fulfilled'; op.result = { content: [{ type: 'text', text: 'cell done' }] }; finish(); }, 200);
        const st = await c.request('tools/call', { name: 'wolfbook_operationStatus',
            arguments: { operation_id: op.id, wait_seconds: 2, client_id: 'VSCode[elsewhere]' } });
        assert.match(JSON.stringify(st.result), /cell done/, 'transport operation resolved, even with a client_id');

        // ---- 8. Legacy economy profile keeps its helpers -----------------------------------
        const e = await sseClient(port, '/sse/economy');
        await e.request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'eco' }, capabilities: {} });
        const eco = new Set((await e.request('tools/list')).result.tools.map(t => t.name));
        assert.ok(eco.has('wolfbook_waitEvaluation') && eco.has('wolfbook_setTarget') && eco.has('wolfbook_tools'),
            'economy still lists its routing helpers, plus wolfbook_tools');
        e.close();
        c.close();
        console.log('stability-tool-exposure: all assertions passed');
    } finally {
        srv.close();
        server.stop?.();
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
