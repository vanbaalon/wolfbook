// The Page view's HTML, and the one-copy rule it depends on.
//
//   node out/extension/kernel/tests/tex-panel.test.js
//
// The markup lives in out/client/tex-viewer.shell.html and is read by BOTH
// texViewer._html() and the headless harness. That arrangement exists because
// the harness previously measured a hand-written page while the shipped panel
// was broken. These assertions keep the two consumers honest: the file must
// exist, the panel must actually inline it, and every element the client script
// looks up by id must be present in it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
};

// __dirname is out/extension/kernel/tests, so the extension root is four up.
const EXT = path.resolve(__dirname, '..', '..', '..', '..');
const CLIENT = path.join(EXT, 'out', 'client');
const SHELL = path.join(CLIENT, 'tex-viewer.shell.html');
const CLIENT_JS = path.join(CLIENT, 'tex-viewer.js');

// Load texViewer against the shared vscode stub.
const { makeVscodeStub } = require('./_stub-vscode.js');
const stub = makeVscodeStub();
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    return req === 'vscode' ? stub : origLoad.call(this, req, ...rest);
};
const { TexViewer } = require('../../tex/texViewer.js');
Module._load = origLoad;

const buildHtml = () => {
    const v = new TexViewer({ extensionUri: { fsPath: EXT } }, {}, {});
    v.panel = {
        webview: {
            cspSource: 'vscode-resource:',
            asWebviewUri: (u) => `https://webview/${u.fsPath}`,
        },
    };
    return v._html();
};

test('the shared shell file exists and is not empty', () => {
    assert.ok(fs.existsSync(SHELL), 'out/client/tex-viewer.shell.html is missing');
    assert.ok(fs.statSync(SHELL).size > 500, 'the shell looks truncated');
});

test('the panel builds its HTML without throwing', () => {
    const html = buildHtml();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.length > 1000, `suspiciously short: ${html.length} bytes`);
});

test('the panel INLINES the shell rather than keeping its own copy', () => {
    const html = buildHtml();
    const shell = fs.readFileSync(SHELL, 'utf8');
    // A distinctive slice of the shell must appear verbatim in the panel.
    // Deliberately just the opening tag: attributes on it (a title, a data-*)
    // are ordinary edits and should not fail the one-copy check.
    const marker = '<div id="pages"';
    assert.ok(shell.includes(marker), 'the shell still holds the page container');
    assert.ok(html.includes(marker), 'and the panel serves it');
    assert.ok(html.includes('<header>'), 'including the toolbar');
});

test('every id the client script looks up exists in the shell', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const wanted = new Set();
    for (const m of js.matchAll(/\bel\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) wanted.add(m[1]);
    for (const m of js.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) wanted.add(m[1]);
    assert.ok(wanted.size >= 6, `expected several ids, found ${wanted.size}`);
    const missing = [...wanted].filter(id => !shell.includes(`id="${id}"`));
    assert.deepStrictEqual(missing, [],
        `the client script reads ids the markup does not define: ${missing.join(', ')}`);
});

test('the script tag points at the real client module, under a nonce', () => {
    const html = buildHtml();
    assert.ok(/<script nonce="[^"]+" type="module" src="[^"]*tex-viewer\.js"><\/script>/.test(html),
        'the module script tag is missing or malformed');
    const nonce = /nonce-([^']+)'/.exec(html);
    assert.ok(nonce, 'the CSP declares a nonce');
    assert.ok(html.includes(`nonce="${nonce[1]}"`), 'and the script carries that same nonce');
});

test('the CSP is still locked down', () => {
    const html = buildHtml();
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html);
    assert.ok(csp, 'there is a CSP');
    assert.ok(csp[1].includes("default-src 'none'"), 'default-src none');
    assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp[1]), "no bare 'unsafe-eval'");
    assert.ok(!/\*/.test(csp[1]), 'no wildcard source');
});

test('the highlight is a wash with a fade, not a red box', () => {
    // The red outline read as an error and boxed in single glyphs; this is the
    // assertion that stops it coming back.
    const shell = fs.readFileSync(SHELL, 'utf8');
    const rule = /\.hl\s*\{([^}]*)\}/.exec(shell);
    assert.ok(rule, 'there is an .hl rule');
    assert.ok(/background:/.test(rule[1]), 'it paints a background wash');
    assert.ok(!/outline:/.test(rule[1]), 'and draws no outline');
    assert.ok(/animation:\s*hlfade/.test(rule[1]), 'and fades');
    assert.ok(/@keyframes hlfade/.test(shell), 'the fade is defined');
    assert.ok(/\.hl\.pinned\s*\{[^}]*animation:\s*none/.test(shell),
        'pinning stops the fade');
});

test('EVERY open is timed, not just the first', () => {
    // The module-level marks are reported once per session (state.reportedTiming),
    // so live rebuilds — the thing that happens hundreds of times while writing —
    // were invisible. Asserted against the SHIPPED client, which is the only
    // client: a harness that drives its own copy measures nothing.
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/kind:\s*'open'/.test(js), 'the client posts a per-open timing report');
    assert.ok(/omark\('total'\)/.test(js), 'including the total');
    assert.ok(/omark\('parse'\)/.test(js) && /omark\('visible'\)/.test(js),
        'and the phases worth blaming');
    // The text-layer sweep walks every page, so its cost belongs in the log too.
    assert.ok(/type:\s*'textLayerDone'[\s\S]{0,160}ms:/.test(js),
        'the text-layer sweep reports how long it took');
});

console.log('the Page view panel (markup, CSP, one-copy rule)\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
