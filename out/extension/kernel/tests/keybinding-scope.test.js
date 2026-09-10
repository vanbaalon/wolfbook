'use strict';

// WHERE OUR KEYBOARD SHORTCUTS ARE ALLOWED TO EXIST.
//
//   node out/extension/kernel/tests/keybinding-scope.test.js
//
// Reported alongside vanbaalon/wolfbook#17: shortcuts leaking into file formats
// this extension is not being asked to handle. Ctrl+V was bound in EVERY .tex
// file from the moment the extension activated, and Alt+[ / Alt+] with it —
// whether or not the reader had ever opened WPaper.
//
// A binding that fires and does nothing has still TAKEN the key from whatever
// else wanted it, so scoping has to happen in the `when` clause, not inside the
// command. That is what these assert.

const assert = require('assert');
const pkg = require('../../../../package.json');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const KB = pkg.contributes.keybindings || [];
const when = (k) => k.when || '';
const label = (k) => `${k.key} -> ${k.command}`;

// ── nothing is unscoped ───────────────────────────────────────────────────

console.log('scope');

t('there are keybindings to check', () => {
    assert.ok(KB.length > 20, `only ${KB.length} — the manifest is not being read`);
});

t('every binding has a when-clause', () => {
    const bare = KB.filter(k => !when(k).trim()).map(label);
    assert.deepStrictEqual(bare, [], `active in every file: ${bare.join(', ')}`);
});

t('every binding names a document type, or a state of ours', () => {
    // Otherwise it is live in Markdown, JSON, plain text — anything.
    //
    // A STATE key counts, and is sometimes tighter than a file type: the
    // debugger's F5/F10/F11 are bound only while wolfbook.debugActive, which is
    // exactly as long as a Wolfram debug session is running. Taking VS Code's
    // debug keys then is the correct behaviour for a debug adapter; taking them
    // the rest of the time would not be.
    const typed = /notebookType|resourceExtname|resourceLangId|editorLangId|activeCustomEditorId|activeWebviewPanelId|view ==|focusedView/;
    const ourState = /wolfbook\.debugActive|wolframInEscapeMode|wolframKernelActive|wolfbook\.texViewerOpen/;
    const loose = KB.filter(k => !typed.test(when(k)) && !ourState.test(when(k))).map(label);
    assert.deepStrictEqual(loose, [],
        `live everywhere, in every file: ${loose.join(', ')}`);
});

t('a binding scoped only by state is scoped by a NARROW state', () => {
    // "The kernel is running" is not a scope — it is true for a whole session.
    const typed = /notebookType|resourceExtname|resourceLangId|editorLangId|activeCustomEditorId|activeWebviewPanelId|view ==|focusedView/;
    const stateOnly = KB.filter(k => !typed.test(when(k)));
    const tooBroad = stateOnly
        .filter(k => /wolframKernelActive/.test(when(k)) && !/wolfbook\.debugActive/.test(when(k)))
        .map(label);
    assert.deepStrictEqual(tooBroad, [],
        `scoped only by "a kernel exists", which is most of a session: ${tooBroad.join(', ')}`);
});

t('every binding is behind an enable switch', () => {
    // So a reader can have their own bindings back without uninstalling.
    const ungated = KB.filter(k => !/wolfbook\.keys(Tex|Notebook)/.test(when(k))).map(label);
    assert.deepStrictEqual(ungated, [], `cannot be turned off: ${ungated.join(', ')}`);
});

// ── .tex is stricter ──────────────────────────────────────────────────────

console.log('.tex');

const TEX = KB.filter(k => /resourceExtname == \.tex/.test(when(k)));

t('there are .tex bindings to check', () => {
    assert.ok(TEX.length >= 3, `expected the tex bindings, found ${TEX.length}`);
});

t('paper-editing bindings require WPaper; open and explicit Git actions do not', () => {
    // Opening the viewer is the reader saying "this paper is mine to work on",
    // and that is exactly when intrusive editing shortcuts should exist. The
    // Git keys are explicit, high-modifier repository actions requested for
    // the ordinary editor too; requiring an unrelated viewer would make them
    // mysteriously disappear.
    const allowedWithoutViewer = new Set([
        'wolfbook.tex.openViewer',
        'wolfbook.tex.commitChanges',
        'wolfbook.tex.pushChanges',
    ]);
    const offenders = TEX
        .filter(k => !allowedWithoutViewer.has(k.command))
        .filter(k => !/wolfbook\.texViewerOpen/.test(when(k)))
        .map(label);
    assert.deepStrictEqual(offenders, [],
        `live in any .tex, viewer or no viewer: ${offenders.join(', ')}`);
});

t('Ctrl+V in a .tex is one of them', () => {
    // The most intrusive of the leaks: paste is not a key to take lightly.
    const paste = KB.find(k => k.key === 'ctrl+v' && /\.tex/.test(when(k)));
    assert.ok(paste, 'the smart-paste binding is expected to exist');
    assert.ok(/wolfbook\.texViewerOpen/.test(when(paste)),
        'Ctrl+V must not be ours in a .tex the reader is only editing');
    assert.ok(/wolfbook\.keysTex/.test(when(paste)), 'and must be switchable off');
});

t('the open-the-viewer shortcut exists, and does NOT require the viewer', () => {
    const open = KB.find(k => k.command === 'wolfbook.tex.openViewer');
    assert.ok(open, 'nothing about a .tex suggests the viewer exists; a shortcut is half the answer');
    assert.ok(!/texViewerOpen/.test(when(open)), 'it would be unreachable');
    assert.ok(/resourceExtname == \.tex/.test(when(open)), 'and only in a .tex');
});

t('that shortcut is on a key nothing else here uses', () => {
    const open = KB.find(k => k.command === 'wolfbook.tex.openViewer');
    const sameKey = KB.filter(k => k.key === open.key);
    assert.strictEqual(sameKey.length, 1, `${open.key} is bound ${sameKey.length} times`);
    // ctrl, not cmd, on every platform: on macOS `ctrl` is Control, so it cannot
    // collide with the Cmd-based defaults.
    assert.ok(/^ctrl\+/.test(open.key), `${open.key} should avoid the Cmd space entirely`);
});

// ── the switches are real ─────────────────────────────────────────────────

console.log('the switches');

const props = (() => {
    const cfg = pkg.contributes.configuration;
    return Array.isArray(cfg) ? Object.assign({}, ...cfg.map(c => c.properties)) : cfg.properties;
})();

t('both switches are declared and default to ON', () => {
    for (const key of ['wolfbook.keybindings.notebook', 'wolfbook.keybindings.tex']) {
        const d = props[key];
        assert.ok(d, `${key} is undeclared — nobody can find it`);
        assert.strictEqual(d.default, true, `${key} must default on; the shortcuts are the product`);
    }
});

t('the context keys are actually set from those settings', () => {
    const fs = require('fs');
    const path = require('path');
    const ext = fs.readFileSync(path.join(__dirname, '..', '..', 'extension.js'), 'utf8');
    assert.ok(/wolfbook\.keysNotebook/.test(ext) && /wolfbook\.keysTex/.test(ext),
        'a when-clause on a context key nobody sets is a binding that never fires');
    assert.ok(/onDidChangeConfiguration/.test(ext),
        'and toggling the setting must take effect without a reload');
});

t('texViewerOpen is set on both open and close', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'texViewer.js'), 'utf8');
    assert.ok(/_setViewerContext\(true\)/.test(src), 'set when a panel is wired');
    assert.ok(/_setViewerContext\(false\)/.test(src), 'and cleared when it is disposed');
    const ext = fs.readFileSync(path.join(__dirname, '..', '..', 'extension.js'), 'utf8');
    assert.ok(/'wolfbook\.texViewerOpen', false/.test(ext),
        'and false at activation — a stale key from a previous window would leave ' +
        'the .tex shortcuts live with nothing behind them');
});

// ── the hint ──────────────────────────────────────────────────────────────

console.log('the first-open hint');

t('a .tex opened for the first time offers the viewer, once ever', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'index.js'), 'utf8');
    assert.ok(/wolfbook\.tex\.viewerHintShown/.test(src), 'remembered in globalState');
    assert.ok(/store\.get\(HINT_KEY\)/.test(src) && /store\.update\(HINT_KEY, true\)/.test(src),
        'shown once ever — repeated on every launch it is an advert');
    assert.ok(/update\(HINT_KEY, true\)[\s\S]{0,400}showInformationMessage/.test(src),
        'the flag is set BEFORE the message, or two .tex files opened together ask twice');
});

t('the hint names both the shortcut and the icon', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'index.js'), 'utf8');
    assert.ok(/Ctrl\+Alt\+W/.test(src), 'the shortcut');
    assert.ok(/wolf icon/.test(src), 'and the thing that was not obvious');
});

t('the hint can never break opening a file', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'index.js'), 'utf8');
    const i = src.indexOf('const maybeOfferViewer');
    const body = src.slice(i, i + 1400);
    assert.ok(/try \{/.test(body) && /catch \(_\)/.test(body), 'wrapped');
});

console.log(`\n${pass} assertions passed`);
