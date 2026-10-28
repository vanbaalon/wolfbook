'use strict';
// Render the actual Wolfbook sidebar HTML/script in isolated headless Chrome.
// No account/network/session is used. node .../webview/overleaf-sidebar.cjs
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { withVscodeStub, makeVscodeStub } = require('../_stub-vscode');
const root = path.resolve(__dirname, '../../../../..');
let pw;
for (const pkg of [process.env.WPAPER_PLAYWRIGHT, path.join(root, 'node_modules/playwright'), '/Users/k0959535/Dropbox/Programming/WLaTeX/wlatex/desktop/node_modules/playwright', 'playwright']) {
    if (!pkg) continue;
    try { pw = require(pkg); break; } catch (_) {}
}
if (!pw) throw Error('Playwright not found; set WPAPER_PLAYWRIGHT.');
(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/watchPanel.webview.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'out/extension/debugger/watchPanel.webview.js'))); }
        else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); }
        else { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const stub = makeVscodeStub();
    const { WatchPanelProvider } = withVscodeStub(() => require('../../../debugger/watchPanel'), stub);
    let html = new WatchPanelProvider({})._buildHtml({ webview: { cspSource: origin, asWebviewUri: uri => uri.fsPath.endsWith('watchPanel.webview.js') ? origin + '/watchPanel.webview.js' : origin + '/asset' } });
    html = html.replace('window._vscode = acquireVsCodeApi();', 'window.__posted = []; window._vscode = { postMessage: function(m) { window.__posted.push(m); } };');
    html = html.replace('<body>', '<body style="background:#252526;color:#ddd;font-family:system-ui;font-size:12px;--vscode-editor-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#454545;--vscode-input-background:#333;--vscode-input-foreground:#ddd;--vscode-button-background:#0e639c;--vscode-button-foreground:white;">');
    const browser = await pw.chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 310, height: 1100 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(() => window.__posted.some(m => m.command === 'scriptLoaded'));
        await page.click('#tab-btn-overleaf');
        assert.ok(await page.evaluate(() => window.__posted.some(m => m.command === 'requestOverleafState' && m.refresh)));
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { command: 'overleafState', state: {
            account: 'connected', detail: 'Choose a project to open in WPaper.', projects: [{ id: 'a', name: 'Integrability and spectral curves' }, { id: 'b', name: '<img src=x onerror=alert(1)>' }],
            recent: [{ root: '/papers/SoV', name: 'Separation of variables', mode: 'live' }, { root: '/papers/QSC', name: 'Quantum spectral curve', mode: 'git' }], live: { connected: true, title: 'Connected to Overleaf in real time: “SoV” — sections/intro.tex' }
        } } })));
        assert.strictEqual(await page.locator('#ol-projects img').count(), 0);
        assert.strictEqual(await page.locator('#ol-projects button').count(), 2);
        await page.fill('#ol-filter', 'integrability');
        assert.strictEqual(await page.locator('#ol-projects button').count(), 1);
        await page.click('#ol-projects button');
        assert.ok(await page.evaluate(() => window.__posted.some(m => m.command === 'overleafAction' && m.action === 'project' && m.id === 'a')));
        await page.click('#ol-git');
        assert.ok(await page.evaluate(() => window.__posted.some(m => m.command === 'overleafAction' && m.action === 'git')));
        await page.screenshot({ path: '/tmp/wolfbook-overleaf-sidebar.png', fullPage: true });
        await page.setViewportSize({ width: 235, height: 1100 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'narrow panel must not overflow horizontally');
        assert.deepStrictEqual(errors, []);
        console.log('Overleaf sidebar browser: loaded script, account/projects, two modes, filter, actions, escaped names, narrow width passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
