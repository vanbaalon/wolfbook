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

test('THE MINI-EDITOR SELECTION IS NOT OPAQUE — an opaque one erases the code', () => {
    // The card is two layers holding the same characters: a coloured <pre> and,
    // exactly on top of it, a textarea whose own text is TRANSPARENT. So a
    // selection background painted at full opacity does not tint the selected
    // text, it hides it — a solid dark block where the code was, which is what
    // `--vscode-editor-selectionBackground` is in most dark themes.
    const shell = fs.readFileSync(SHELL, 'utf8');
    const rule = /\.editcard textarea::selection\s*\{([^}]*)\}/.exec(shell);
    assert.ok(rule, 'the textarea has a selection rule');
    const body = rule[1];
    assert.ok(/color-mix\(/.test(body) || /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(body),
        'and it is mixed down to a wash, never a bare opaque theme colour');
    assert.ok(!/background:\s*var\(--vscode-editor-selectionBackground[^;]*\);\s*\}/.test(body),
        'the raw theme colour on its own is the bug this test exists for');
    // The inverse-click mark below it is an outline for the same reason: two
    // fills over one run of characters is a smear, not a highlight.
    const sel = /\.ec-sel\s*\{([^}]*)\}/.exec(shell);
    assert.ok(sel, 'there is an .ec-sel rule');
    assert.ok(/box-shadow:\s*inset|outline:/.test(sel[1]), 'it draws an outline');
});

test('every message the client posts has a handler in the extension', () => {
    // The two halves talk over postMessage, so a typo on either side fails
    // SILENTLY — the click simply does nothing, and there is no error anywhere
    // to notice. The wire is small enough to check exhaustively, so it is.
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const viewer = fs.readFileSync(
        path.join(__dirname, '../../tex/texViewer.js'), 'utf8');

    const sent = new Set();
    for (const m of js.matchAll(/postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g)) sent.add(m[1]);
    // sendClick takes its type as a parameter, with 'click' as the default.
    for (const m of js.matchAll(/sendClick\([^;]*?,\s*'([a-zA-Z]+)'\s*\)/g)) sent.add(m[1]);
    sent.add('click');

    const handled = new Set();
    for (const m of viewer.matchAll(/case '([a-zA-Z]+)':/g)) handled.add(m[1]);

    const orphans = [...sent].filter(t => !handled.has(t));
    assert.deepStrictEqual(orphans, [],
        'the client posts these and nothing answers them: ' + orphans.join(', '));
    assert.ok(sent.has('insertCommit') && sent.has('mmaRun'),
        'the computation gesture is really in the client (the check would pass vacuously otherwise)');
});

test('the client really parses as an ES module', () => {
    // `node --check` does NOT catch duplicate lexical declarations in an ES
    // module. That gap already cost this project a whole feature once: a
    // `const meta` / `let meta` clash passed the syntax check and made the 3D
    // viewer fail to import, silently, everywhere (CLAUDE.md, "Traps that cost
    // real time here"). A module parse catches it; the browser harness catches
    // it too, but only on a machine with Chrome, and this gate runs everywhere.
    //
    // Spawned with the flag rather than relying on this process having it:
    // run-all.js spawns each suite as a plain `node file.js`, so a check that
    // needed the flag would silently skip — and a test that always passes is
    // worse than no test at all.
    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath, ['--experimental-vm-modules', '-e', `
        const vm = require('vm'); const fs = require('fs');
        new vm.SourceTextModule(fs.readFileSync(process.argv[1], 'utf8'));
    `, CLIENT_JS], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0,
        'out/client/tex-viewer.js does not parse as a module:\n' +
        String(res.stderr || '').split('\n').slice(0, 6).join('\n'));
});

test('the mini-editor card is draggable by its title, and steps between blocks', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const shell = fs.readFileSync(SHELL, 'utf8');
    assert.ok(/function makeDraggable\(/.test(js), 'the drag handler exists');
    assert.ok(/makeDraggable\(card, head[,)]/.test(js), 'and is wired to the HEADER, not the card');
    // The position is a FRACTION of the page, so zoom cannot strand it. Both
    // cards share one drag handler, so the fraction is now stored on whichever
    // session that handler was given rather than on state.edit by name.
    assert.ok(/e\.pos = \{ fx: left \/ W, fy: top \/ H \}/.test(js),
        'the position is remembered as a fraction of the page, so zoom cannot strand it');
    assert.ok(/get: \(\) => state\.edit/.test(js) && /get: \(\) => state\.mma/.test(js),
        'and both cards supply their own session to the shared handler');
    assert.ok(/\.ec-head\s*\{[^}]*user-select:none/.test(shell),
        'dragging the header must not select its text');
    assert.ok(/type: 'editStep'/.test(js), 'the card posts block steps');
    assert.ok(/altKey && \(ev\.key === 'ArrowUp'/.test(js), 'and ⌥↑/⌥↓ do it from the keyboard');
});

test('a click ships WHERE the repeated words are, not just how many', () => {
    // Counting occurrences along the printed ROW is not counting them along the
    // SOURCE LINE — a row routinely carries the tail of one line and the head of
    // the next. The webview therefore ships the positions and lets the
    // extension, which has the SyncTeX rows, do the counting.
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/wordSpots:/.test(js) && /wordAt:/.test(js), 'the click carries the prose spots');
    assert.ok(/glyphSpots:/.test(js) && /glyphAt:/.test(js), 'and the maths ones');
    assert.ok(/const cx = w\.x \+ w\.w \/ 2;/.test(js),
        'and the forward direction filters candidates by WORD, not by text item');
    // Positions can only ever be as good as SyncTeX's line attribution, and
    // measured, that attribution is wrong at row boundaries — where a source
    // line's first word almost always sits. The printed NEIGHBOURS are not.
    assert.ok(/wordContext:/.test(js), 'the click carries the words around it');
    assert.ok(/function readingContext\(/.test(js), 'gathered in reading order');
    assert.ok(/all\.sort\(\(a, b\) => a\.row - b\.row \|\| a\.x - b\.x\)/.test(js),
        'by clustering rows first — a "close enough" comparator is not a total order');
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
