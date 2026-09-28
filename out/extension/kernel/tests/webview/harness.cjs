#!/usr/bin/env node
'use strict';

// harness.cjs — runs WPaper's REAL webview (out/client/tex-viewer.shell.html +
// tex-viewer.js) in Chromium and drives it only the way the extension host
// does: messages in (window.postMessage) and messages out (a mocked
// acquireVsCodeApi that records into window.__posted).
//
//   node out/extension/kernel/tests/webview/harness.cjs            # every test
//   node out/extension/kernel/tests/webview/harness.cjs 35 30      # ids matching
//
// The page is built by the host's own TexViewer.prototype._html (same CSP,
// same nonce'd scripts, same shell), with the vscode module stubbed and
// asWebviewUri pointing at a local http server that serves out/client. The
// only things added are the acquireVsCodeApi mock and a few VS Code theme
// variables.
//
// The fixture PDF is compiled once (xelatex, else pdflatex) into
// os.tmpdir()/wpaper-webview-fixture-<hash>/ and its word boxes are read with
// poppler's `pdftotext -bbox`, so tests can aim at real words.
//
// Playwright is not a dependency of this repo. It is resolved from, in order:
// $WPAPER_PLAYWRIGHT, this repo's node_modules, and the WLaTeX desktop
// checkout's node_modules. Chrome: $CHROME_PATH, else the system Google
// Chrome, else Playwright's own Chromium.
//
// Always headless: it never opens a window.
//
// Tests live in tex-webview-bugs.spec.cjs next to this file
// ($WPAPER_WEBVIEW_SPEC overrides). $WPAPER_EXT_ROOT runs them against another
// extension root's out/client (e.g. an older build, to see a test fail).
// Not part of run-all.js (that runner is headless-only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXT = path.resolve(__dirname, '..', '..', '..', '..', '..');
// The client under test: this repo's out/client, or another tree's (a build
// to compare against) when WPAPER_EXT_ROOT names an extension root.
const CLIENT_ROOT = process.env.WPAPER_EXT_ROOT ? path.resolve(process.env.WPAPER_EXT_ROOT) : EXT;
const CLIENT = path.join(CLIENT_ROOT, 'out', 'client');
const SPEC = process.env.WPAPER_WEBVIEW_SPEC || path.join(__dirname, 'tex-webview-bugs.spec.cjs');
const TEST_TIMEOUT_MS = 30000;

// --- playwright + a browser ---------------------------------------------------

function loadPlaywright() {
    const tries = [
        process.env.WPAPER_PLAYWRIGHT,
        path.join(EXT, 'node_modules', 'playwright'),
        path.join(EXT, 'node_modules', 'playwright-core'),
        '/Users/k0959535/Dropbox/Programming/WLaTeX/wlatex/desktop/node_modules/playwright',
        'playwright',
        'playwright-core',
    ].filter(Boolean);
    for (const t of tries) {
        try { return { pw: require(t), from: t }; } catch (_) { /* next */ }
    }
    throw new Error('Playwright not found. Set WPAPER_PLAYWRIGHT to a playwright package directory.');
}

function chromePath() {
    const c = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean);
    return c.find(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

// --- the fixture --------------------------------------------------------------

function buildFixture(tex) {
    const hash = crypto.createHash('sha1').update(tex).digest('hex').slice(0, 12);
    const dir = path.join(os.tmpdir(), `wpaper-webview-fixture-${hash}`);
    const pdf = path.join(dir, 'fx.pdf');
    if (!fs.existsSync(pdf)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'fx.tex'), tex);
        let ok = false, lastErr = null;
        for (const engine of ['xelatex', 'pdflatex']) {
            try {
                execFileSync(engine, ['-interaction=nonstopmode', '-halt-on-error', 'fx.tex'],
                    { cwd: dir, stdio: 'pipe', timeout: 120000 });
                ok = fs.existsSync(pdf);
                if (ok) break;
            } catch (e) { lastErr = e; }
        }
        if (!ok) throw new Error(`could not compile the fixture in ${dir}: ${lastErr && lastErr.message}`);
    }
    let xml;
    try { xml = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' }); }
    catch (e) { throw new Error('pdftotext (poppler) is needed to read the fixture\'s word boxes: ' + e.message); }
    const pages = [];
    const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
    let pm;
    while ((pm = pageRe.exec(xml))) {
        const words = [];
        const wre = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
        let wm;
        while ((wm = wre.exec(pm[3]))) {
            const [x0, y0, x1, y1] = wm.slice(1, 5).map(Number);
            words.push({ page: pages.length + 1, text: wm[5], x: x0, y: y0, w: x1 - x0, h: y1 - y0, x1, y1 });
        }
        pages.push({ width: Number(pm[1]), height: Number(pm[2]), words });
    }
    return { dir, pdf, base64: fs.readFileSync(pdf).toString('base64'), pages };
}

// --- the page the host would build ---------------------------------------------

function hostHtml(origin) {
    const { withVscodeStub } = require(path.join(EXT, 'out', 'extension', 'kernel', 'tests', '_stub-vscode.js'));
    const { TexViewer } = withVscodeStub(() => require(path.join(EXT, 'out', 'extension', 'tex', 'texViewer.js')));
    const webview = {
        cspSource: origin,
        asWebviewUri: (uri) => {
            const rel = path.relative(CLIENT, uri.fsPath).split(path.sep).join('/');
            if (rel.startsWith('..')) throw new Error(`asWebviewUri outside out/client: ${uri.fsPath}`);
            return { toString: () => `${origin}/${rel}` };
        },
    };
    const html = TexViewer.prototype._html.call({ panel: { webview }, context: { extensionUri: { fsPath: CLIENT_ROOT, path: CLIENT_ROOT } } });
    const nonce = (/nonce="([^"]+)"/.exec(html) || [])[1];
    if (!nonce) throw new Error('the host page has no script nonce — _html changed shape');
    // VS Code puts its theme into the page as CSS variables and body classes.
    const theme = `<style>:root{--vscode-font-family:-apple-system,system-ui,sans-serif;--vscode-editor-background:#ffffff;
--vscode-foreground:#1f1f1f;--vscode-panel-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;
--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-focusBorder:#005fb8;
--vscode-editor-findMatchBackground:#ff0000;--vscode-editor-findMatchHighlightBackground:#ff0000;}</style>`;
    const mock = `<script nonce="${nonce}">
(() => {
  const posted = [], postedAt = [], all = [];
  let saved;
  window.__posted = posted; window.__postedAt = postedAt; window.__all = all;
  window.__clearPosted = () => { posted.length = 0; postedAt.length = 0; };
  let acquired = false;
  window.acquireVsCodeApi = () => {
    if (acquired) throw new Error('acquireVsCodeApi called twice');
    acquired = true;
    return {
      postMessage(m) { const c = structuredClone(m); posted.push(c); postedAt.push(performance.now()); all.push(c); },
      getState() { return saved; },
      setState(s) { saved = s; return s; },
    };
  };
  document.addEventListener('DOMContentLoaded', () => document.body.classList.add('vscode-light'));
})();
</script>`;
    return html
        .replace('</head>', `${theme}</head>`)
        .replace(/<script nonce=/, `${mock}\n<script nonce=`);
}

function serve(getIndex) {
    const MIME = {
        '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
        '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
        '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
    };
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        if (url === '/' || url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getIndex());
            return;
        }
        const file = path.resolve(CLIENT, '.' + url);
        if (!file.startsWith(CLIENT + path.sep)) { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(buf);
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// --- PNG decoding (screenshots), no dependencies -------------------------------

function decodePng(buf) {
    let pos = 8, w = 0, h = 0, depth = 0, type = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const kind = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (kind === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9];
            if (data[12]) throw new Error('interlaced PNG');
        } else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        pos += 12 + len;
    }
    const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
    if (depth !== 8 || !bpp) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    const out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
            if (f === 1) line[i] += a;
            else if (f === 2) line[i] += b;
            else if (f === 3) line[i] += (a + b) >> 1;
            else if (f === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                line[i] += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, s = x * bpp;
            if (type === 6) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = line[s + 3]; }
            else if (type === 2) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = 255; }
            else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = 255; }
            else { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = line[s + 1]; }
        }
        prev = line;
    }
    return { width: w, height: h, data: out };
}

// --- the per-test context ---------------------------------------------------------

class AssertionError extends Error {}

function makeContext(page, fixture, origin) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const t = {
        page, fixture, origin, sleep,
        assert(cond, msg) { if (!cond) throw new AssertionError(msg); },
        near(a, b, tol, msg) {
            if (!(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol))
                throw new AssertionError(`${msg} (got ${a}, wanted ${b} ± ${tol})`);
        },
        /** A message from the "host". */
        post: (msg) => page.evaluate(m => window.postMessage(m, '*'), msg),
        posted: (type) => page.evaluate(ty => window.__posted.filter(m => !ty || m.type === ty), type || null),
        clear: () => page.evaluate(() => window.__clearPosted()),
        eval: (fn, arg) => page.evaluate(fn, arg),
        async waitFor(fn, arg, { timeout = 5000, what = 'condition' } = {}) {
            try { return await (await page.waitForFunction(fn, arg, { timeout, polling: 20 })).jsonValue(); }
            catch (e) { throw new AssertionError(`timed out waiting for ${what}`); }
        },
        /** The first posted message of a type (matching `pred`, evaluated here in Node). */
        async waitPosted(type, pred = null, timeout = 3000) {
            const until = Date.now() + timeout;
            for (;;) {
                const found = (await t.posted(type)).find(m => !pred || pred(m));
                if (found) return found;
                if (Date.now() > until) throw new AssertionError(`the panel never posted '${type}'`);
                await sleep(15);
            }
        },
        /** A word of the fixture by its text (n-th occurrence). */
        word(text, n = 0) {
            const nfc = (x) => String(x).normalize('NFC');
            const all = fixture.pages.flatMap(p => p.words).filter(w => nfc(w.text) === nfc(text));
            if (!all[n]) throw new Error(`fixture has no word ${JSON.stringify(text)} #${n}`);
            return all[n];
        },
        /** Page coordinates in bp → client (CSS) pixels, and the page's px-per-bp. */
        async toClient(pageNo, xBp, yBp) {
            const W = fixture.pages[pageNo - 1].width;
            return page.evaluate(([n, x, y, width]) => {
                const w = document.querySelector(`.page[data-page="${n}"]`);
                const r = w.getBoundingClientRect();
                const k = r.width / width;
                return { x: r.left + x * k, y: r.top + y * k, k, left: r.left, top: r.top };
            }, [pageNo, xBp, yBp, W]);
        },
        async pxPerBp(pageNo = 1) { return (await t.toClient(pageNo, 0, 0)).k; },
        /** RGBA pixels of a client rect. */
        async pixels(rect) {
            const clip = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
            return decodePng(await page.screenshot({ clip, scale: 'css', animations: 'disabled' }));
        },
        /** Open the fixture (again) as a given generation. */
        async open(generation, extra = {}) {
            await t.post({ type: 'open', base: `${origin}/pdfjs`, pdfBase64: fixture.base64,
                generation, pages: fixture.pages.length, ...extra });
            await t.waitFor(g => window.__all.some(m => m.type === 'opened' && m.generation === g) &&
                !!document.querySelector('#pages .page[data-page="1"] canvas'), generation,
            { timeout: 15000, what: `the PDF (generation ${generation}) to render` });
            await sleep(120);
        },
    };
    return t;
}

// --- main -------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    const filters = args.filter(a => !a.startsWith('--')).map(a => a.replace(/^#/, ''));
    const spec = require(SPEC);

    const { pw, from } = loadPlaywright();
    const chromium = pw.chromium;
    const fixture = buildFixture(spec.fixtureTex);

    let indexHtml = '';
    const server = await serve(() => indexHtml);
    const origin = `http://127.0.0.1:${server.address().port}`;
    indexHtml = hostHtml(origin);

    const exe = chromePath();
    const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    console.log(`WPaper webview tests — playwright ${from}, browser ${exe || 'bundled chromium'} ${browser.version()}`);
    console.log(`client ${CLIENT}\nfixture ${fixture.pdf}`);

    const tests = spec.tests.filter(tc => !filters.length ||
        filters.some(f => tc.id.replace(/^#/, '') === f || tc.name.toLowerCase().includes(f.toLowerCase())));
    const counts = { ok: 0, fail: 0, todo: 0, xpass: 0 };
    for (const tc of tests) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
        page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
        const t = makeContext(page, fixture, origin);
        const t0 = Date.now();
        let error = null;
        try {
            await page.goto(`${origin}/index.html`);
            await t.waitFor(() => window.__all && window.__all.some(m => m.type === 'ready'), null,
                { timeout: 10000, what: 'the panel to post ready' });
            await t.open(1);
            await t.clear();
            await Promise.race([
                tc.run(t),
                new Promise((_, rej) => setTimeout(() => rej(new AssertionError(`timed out after ${TEST_TIMEOUT_MS} ms`)), TEST_TIMEOUT_MS)),
            ]);
        } catch (e) { error = e; }
        const ms = Date.now() - t0;
        const label = `${tc.id} ${tc.name}`;
        const why = error ? (error instanceof AssertionError ? error.message : (error.stack || String(error)).split('\n').slice(0, 3).join(' | ')) : '';
        if (tc.todo) {
            if (error) { counts.todo++; console.log(`todo  ${label}  [${ms} ms]\n        expected failure: ${tc.todo}\n        ${why}`); }
            else { counts.xpass++; console.log(`XPASS ${label}  [${ms} ms]\n        marked todo but passes now — remove the todo mark`); }
        } else if (error) {
            counts.fail++;
            console.log(`FAIL  ${label}  [${ms} ms]\n        ${why}`);
        } else {
            counts.ok++;
            console.log(`ok    ${label}  [${ms} ms]`);
        }
        if ((error || process.env.WPAPER_VERBOSE) && pageErrors.length)
            console.log('        page errors: ' + [...new Set(pageErrors)].slice(0, 4).join(' || '));
        await context.close();
    }
    await browser.close();
    server.close();
    console.log(`\n${counts.ok} passed, ${counts.fail} failed, ${counts.todo} todo (expected failures), ${counts.xpass} unexpectedly passing`);
    process.exit(counts.fail ? 1 : 0);
}

if (require.main === module) {
    main().catch(e => { console.error('harness error:', e && e.stack || e); process.exit(2); });
}

module.exports = { decodePng, buildFixture, hostHtml, serve, loadPlaywright, chromePath, CLIENT };
