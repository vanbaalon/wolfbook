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

test('general page gestures live in the guide, not a page-wide tooltip', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const pages = /<div id="pages"([^>]*)>/.exec(shell);
    assert.ok(pages, 'the PDF surface exists');
    assert.ok(!/\btitle=/.test(pages[1]), 'hovering anywhere on the paper shows no long hint');
    assert.ok(!/armHint\(pages/.test(js), 'the client does not restore that hint later');
});

test('the layout control advertises and sends its two-state toggle', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/id="full"[^>]*title="Show WPaper only"[^>]*aria-label="Show WPaper only"/.test(shell),
        'the toolbar states the next of the two layouts');
    assert.ok(/el\('full'\)\.addEventListener\('click',[\s\S]{0,120}type: 'layoutCycle'/.test(js),
        'the button asks the extension to advance, rather than guessing state locally');
    assert.ok(/Show editor \+ WPaper/.test(js),
        'the focused state offers the editor-and-viewer layout');
    assert.ok(!/viewerAgents/.test(js) && !/layout-agents/.test(shell),
        'the retired agent-panel layout is absent from the toolbar client');
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

test('a focused review change has one exterior contour, not boxes around its rows', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const focusedBand = /\.rband\.on\s*\{([^}]*)\}/.exec(shell);
    assert.ok(focusedBand, 'the focused-band rule exists');
    assert.ok(/outline:\s*none/.test(focusedBand[1]), 'individual PDF fragments have no outline');
    assert.ok(/\.rcontour\s*\{/.test(shell), 'the page has a dedicated exterior contour');
    assert.ok(/function paintReviewContour\(/.test(js), 'review rectangles are combined');
    assert.ok(/createElementNS\(ns, 'feMorphology'\)/.test(js), 'the outline is made from their union');
    assert.ok(/\.rband, \.rcontour, \.rchip/.test(js), 'the contour is cleared with the review');
});

test('a stale page has a compact tracing-paused indicator', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/id="tracelag" hidden/.test(shell), 'the indicator starts out of the way');
    assert.ok(/#tracelag\.compiling::before/.test(shell), 'an in-progress update gets a small spinner');
    assert.ok(/case 'traceState': setTraceState\(msg\)/.test(js), 'the lag state reaches the indicator');
    assert.ok(/if \(state\.tracePaused\) return;/.test(js), 'stale pages do not resolve clicks');
});

test('unsaved source has its own persistent save control in the viewer', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/id="sourceunsaved" hidden/.test(shell), 'saved papers do not spend toolbar space');
    assert.ok(/Unsaved source/.test(shell), 'the visible state says what is unsaved');
    assert.ok(/case 'sourceDirty': setSourceDirty\(msg\)/.test(js), 'disk state has its own message');
    assert.ok(/postMessage\(\{ type: 'saveSource' \}\)/.test(js), 'the badge itself saves the source');
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

test('every place the tour points at exists on the page', () => {
    // A step that points at nothing draws its ring over empty space, and the
    // reader is told to press a button that is not there. Cheap to check and
    // exactly the kind of thing that rots when the toolbar is rearranged.
    const shell = fs.readFileSync(SHELL, 'utf8');
    const steps = fs.readFileSync(
        path.join(__dirname, '../../tex/tourSteps.js'), 'utf8');
    const points = [...steps.matchAll(/point:\s*'#([a-zA-Z][\w-]*)'/g)].map(m => m[1]);
    assert.ok(points.length >= 3, 'the tour points at something (found ' + points.length + ')');
    const missing = points.filter(id => !new RegExp(`id="${id}"`).test(shell));
    assert.deepStrictEqual(missing, [], 'the tour points at ids the page does not have');
});

test('every gesture the tour waits for is one the panel actually sends', () => {
    // A step whose satisfy() names a message nobody posts can never be
    // completed: the tour stops dead on it and the reader cannot get past
    // except by skipping. The tour is fed EVERY panel message, so the check is
    // just whether the client says it.
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const steps = fs.readFileSync(
        path.join(__dirname, '../../tex/tourSteps.js'), 'utf8');
    const wanted = new Set(
        [...steps.matchAll(/e\.type === '([a-zA-Z]+)'/g)].map(m => m[1]));
    // `cursor` has no webview message: the forward sync raises it directly.
    wanted.delete('cursor');
    const sent = new Set();
    for (const m of js.matchAll(/postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g)) sent.add(m[1]);
    for (const m of js.matchAll(/type:\s*[^,\n]*\?\s*'([a-zA-Z]+)'\s*:\s*'([a-zA-Z]+)'/g)) {
        sent.add(m[1]); sent.add(m[2]);
    }
    for (const m of js.matchAll(/sendClick\([^;]*?,\s*'([a-zA-Z]+)'\s*\)/g)) sent.add(m[1]);
    sent.add('click');
    const unreachable = [...wanted].filter(t => !sent.has(t));
    assert.deepStrictEqual(unreachable, [],
        'the tour waits for gestures the panel never posts: ' + unreachable.join(', '));
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
    // `type:` written as a choice — two gestures that differ only in what the
    // click finally means share one postMessage. Without this the check goes
    // BLIND to exactly the messages a refactor is most likely to break.
    for (const m of js.matchAll(/type:\s*[^,\n]*\?\s*'([a-zA-Z]+)'\s*:\s*'([a-zA-Z]+)'/g)) {
        sent.add(m[1]); sent.add(m[2]);
    }
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

test('two explicit outward arrows step across a mini-editor boundary', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const from = js.indexOf("ta.addEventListener('keydown', (ev) => {",
        js.indexOf('function buildEditCard('));
    const body = js.slice(from, from + 3200);
    assert.ok(/let boundaryArm = null/.test(js), 'the first boundary press only arms navigation');
    assert.ok(/ev\.key === 'ArrowLeft' && ta\.selectionStart === 0/.test(body),
        'left is considered only at the first character');
    assert.ok(/ev\.key === 'ArrowRight' && ta\.selectionEnd === ta\.value\.length/.test(body),
        'right is considered only after the last character');
    assert.ok(/if \(ev\.repeat\) return/.test(body),
        'holding an arrow cannot step through paragraphs');
    assert.ok(/if \(boundaryArm === here\)/.test(body) &&
        /step\(ev\.key === 'ArrowLeft' \? -1 : 1\)/.test(body),
    'only the second matching physical press steps previous/next');
    assert.ok(/boundaryArm = null;\s*\n\s*if \(ev\.key === 'Escape'\)/.test(body),
        'any other key cancels the armed boundary');
});

test('Ctrl+S sends the current mini-editor text in the save operation', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const from = js.indexOf("else if ((ev.metaKey || ev.ctrlKey)",
        js.indexOf('function buildEditCard('));
    const branch = js.slice(from, from + 700);
    assert.ok(/saveCurrent\(\)/.test(branch),
        'the textarea shortcut uses the shared ordered save operation');
    const shared = js.slice(js.indexOf('function saveCurrent()'),
        js.indexOf('function saveCurrent()') + 500);
    assert.ok(/type: 'editSave', editId: e\.id, text: ta\.value/.test(shared),
        'save carries the exact textarea value instead of racing a pending edit message');
    assert.ok(!/type: 'editChange'/.test(branch),
        'Ctrl+S does not split apply and save into independently scheduled messages');
});

test('Ctrl+S on the paper saves through the same mini-editor operation', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const marker = '// SAVE BELONGS TO THE DOCUMENT';
    const branch = js.slice(js.indexOf(marker), js.indexOf(marker) + 1500);
    assert.ok(/state\.edit\._saveCurrent\(\)/.test(branch),
        'an open card supplies its current text even when focus is on the page');
    assert.ok(/type: 'saveSource'/.test(branch),
        'without a card the viewer saves the paper source buffers');
    assert.ok(/e\.preventDefault\(\)/.test(branch),
        'the webview does not let the browser consume the save gesture');
    assert.ok(/clearTimeout\(debounce\)/.test(js) && /text: ta\.value/.test(js),
        'the shared card operation cancels a pending edit and carries exact current text');
});

test('the mini-editor leaves native copy cut and paste intact', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    const from = js.indexOf("ta.addEventListener('keydown', (ev) => {",
        js.indexOf('function buildEditCard('));
    const body = js.slice(from, from + 3600);
    const firstBranch = body.indexOf("if ((ev.metaKey || ev.ctrlKey) && ev.altKey");
    assert.ok(firstBranch > 0, 'the mini-editor keyboard handler was found');
    assert.ok(!/ev\.stopPropagation\(\)/.test(body.slice(0, firstBranch)),
        'ordinary textarea shortcuts reach VS Code native clipboard handling');
    assert.ok(!/key === ['\"]c['\"]|key === ['\"]x['\"]|key === ['\"]v['\"]/.test(body),
        'the card does not reinterpret clipboard shortcuts as page actions');
    assert.ok(/ev\.preventDefault\(\);\s*\n\s*ev\.stopPropagation\(\)/.test(body),
        'card-owned shortcuts remain contained');
});

test('typing on the paper opens the mini-editor at the resolved click', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/id="pages" tabindex="-1"/.test(shell),
        'the paper has an explicit keyboard focus target');
    assert.ok(/focusPaperForKeys\(\);\s*\n\s*ev\.preventDefault\(\)/.test(js),
        'a page press focuses it even though drag selection prevents default focus');
    assert.ok(/pendingPaperTyping\.text \+= text/.test(js),
        'keystrokes are buffered while the mini-editor opens');
    assert.ok(/type: 'editHere', typingRequest: request\.id/.test(js),
        'typing asks for the ordinary point-resolved mini-editor');
    assert.ok(/msg\.typingRequest === pendingPaperTyping\.id/.test(js) &&
        /ta\.setRangeText\(text, ta\.selectionStart, ta\.selectionEnd, 'end'\)/.test(js),
        'the buffered text is inserted only after the exact card caret returns');
});

test('page selections use standard copy cut paste delete and typing keys', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/command && key === 'c'\) action = 'copy'/.test(js));
    assert.ok(/command && key === 'x'\) action = 'cut'/.test(js));
    assert.ok(/command && key === 'v'\) action = 'paste'/.test(js));
    assert.ok(/e\.key === 'Delete' \|\| e\.key === 'Backspace'\)\) action = 'delete'/.test(js));
    assert.ok(/action = 'replace'/.test(js),
        'ordinary typing replaces a selected fragment as it does in an editor');
    assert.ok(/type: 'selectionAction', action/.test(js),
        'all keys reuse the action bar protocol');
});

test('the webview reports the complete restorable WPaper session', () => {
    const shell = fs.readFileSync(SHELL, 'utf8');
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/top,\s*left:\s*main\.scrollLeft/.test(js),
        'the literal vertical and horizontal scroll offsets travel');
    assert.ok(/scale:\s*state\.scale,\s*fit:\s*!!state\.fitMode/.test(js),
        'magnification and fit mode travel with the page address');
    assert.ok(/xFrac:[\s\S]{0,180}main\.scrollLeft \+ main\.clientWidth \/ 2 - w\.offsetLeft/.test(js) &&
        /a\.xFrac[\s\S]{0,220}w\.offsetWidth - main\.clientWidth \/ 2/.test(js),
        'separator resizing preserves the paper-relative horizontal position, not a stale pixel offset');
    assert.ok(/#pages \{[\s\S]{0,180}width:max-content; min-width:100%/.test(shell),
        'an oversized centred page grows the scroll strip instead of acquiring an unreachable negative edge');
    assert.ok(/id="fit"[\s\S]{0,180}double-click to keep fitted/.test(shell) &&
        /el\('fit'\)\.addEventListener\('dblclick'[\s\S]*type: 'fitMode'/.test(js),
        'Fit exposes a discoverable double-click responsive regime');
    assert.ok(/#fit\[aria-pressed="true"\][\s\S]{0,300}vscode-focusBorder[\s\S]{0,180}box-shadow:inset/.test(shell),
        'responsive Fit remains unmistakably highlighted after the pointer leaves');
    assert.ok(/function responsiveFit\(\)[\s\S]*requestAnimationFrame[\s\S]*live: true[\s\S]*ResizeObserver\(responsiveFit\)/.test(js),
        'responsive Fit tracks the actual reader width with a live preview during separator drags');
    assert.ok(/type:\s*'editView'/.test(js),
        'the mini-editor reports its caret and dragged position');
    assert.ok(/paintEditCard\(!msg\.restored && !msg\.typingRequest\)/.test(js),
        'restoring the card does not scroll away from the saved reading place');
    assert.ok(/restoreSession && msg\.restoreView/.test(js) && /state\.restoreViewNext = true/.test(js),
        'saved magnification is applied to a fresh viewer or paper switch, not over a live recompile');
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

test('a change click can prove the PDF worker and loaded viewer are alive', () => {
    const js = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/workerPort:\s*null/.test(js), 'the worker port is retained after startup');
    assert.ok(/addEventListener\('error',\s*died\)/.test(js), 'late worker death is observed');
    assert.ok(/addEventListener\('messageerror',\s*died\)/.test(js), 'a broken worker channel is observed');
    assert.ok(/async function probeViewer\(/.test(js), 'the viewer has a health probe');
    assert.ok(/getPageIndex\(page\.ref\)/.test(js), 'the probe makes a real worker round-trip');
    assert.ok(/case 'viewerProbe':\s*await probeViewer\(msg\)/.test(js), 'the probe is on the message wire');
});

console.log('the Page view panel (markup, CSP, one-copy rule)\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
