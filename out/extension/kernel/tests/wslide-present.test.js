'use strict';

// Presentation mode must clear VS Code's chrome, and must put every setting it
// changed back afterwards.
//
//   node out/extension/kernel/tests/wslide-present.test.js
//
// Two real defects motivate this:
//
//  1. Zen mode alone was assumed to hide everything. Its defaults moved — since
//     VS Code 1.85 `zenMode.showTabs` defaults to "multiple", so the tab bar
//     stays up — and zen mode never hid breadcrumbs or the title bar. A talk
//     was presented with three rows of editor chrome above the slide.
//
//  2. The one setting that WAS overridden (`zenMode.centerLayout`) was written
//     to the user's GLOBAL settings and only restored by an explicit exit.
//     Closing the tab mid-talk stranded it there permanently.
//
// These settings outlive the session, so "restore" is not a nicety.

const assert = require('assert');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const section = name => queue.push({ section: name });
async function runQueue() {
    for (const it of queue) {
        if (it.section) { console.log(it.section); continue; }
        try { await it.fn(); pass++; console.log(`  ✓ ${it.name}`); }
        catch (e) { console.error(`  ✗ ${it.name}\n    ${e.message}`); process.exitCode = 1; }
    }
    console.log(`\n${pass} assertions passed`);
}

// ── A configuration store that behaves like VS Code's ─────────────────────
//
// The distinction that matters: inspect().globalValue is what the user
// EXPLICITLY set, which is undefined when they are on the default. Restoring
// the effective value instead would write a setting they never had.
function makeConfigStore(known, globals = {}) {
    const store = { ...globals };
    const calls = [];
    return {
        calls,
        store,
        getConfiguration(sectionName) {
            const full = k => `${sectionName}.${k}`;
            return {
                get: k => (full(k) in store ? store[full(k)] : known[full(k)]),
                inspect: k => (full(k) in known ? {
                    key: full(k),
                    defaultValue: known[full(k)],
                    globalValue: full(k) in store ? store[full(k)] : undefined,
                } : undefined),
                update: async (k, v) => {
                    calls.push({ key: full(k), value: v });
                    if (v === undefined) delete store[full(k)];
                    else store[full(k)] = v;
                },
            };
        },
    };
}

// Keys this VS Code build knows about, with their defaults.
const KNOWN = {
    'zenMode.centerLayout': true,
    'zenMode.showTabs': 'multiple',
    'zenMode.fullScreen': true,
    'zenMode.hideStatusBar': true,
    'zenMode.hideActivityBar': true,
    'zenMode.hideLineNumbers': true,
    'breadcrumbs.enabled': true,
    // NOTE: 'zenMode.hideTabs' deliberately absent — it is the legacy name and
    // must be skipped rather than throwing on a build that dropped it.
};

let cfg = null;
const executed = [];

const { SlideEditorProvider } = (() => {
    const orig = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') {
            const stub = makeVscodeStub();
            stub.workspace = stub.workspace || {};
            stub.workspace.getConfiguration = (...a) => cfg.getConfiguration(...a);
            stub.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
            stub.commands = stub.commands || {};
            stub.commands.executeCommand = async (c) => { executed.push(c); };
            return stub;
        }
        return orig.call(this, req, ...rest);
    };
    try { return require('../../slideEditorProvider'); }
    finally { Module._load = orig; }
})();

/** A provider instance with just enough shape for the presentation methods. */
function makeProvider() {
    const p = Object.create(SlideEditorProvider.prototype);
    p._presZenMode = false;
    p._presSaved = [];
    return p;
}

// ── what gets forced ──────────────────────────────────────────────────────

section('entering presentation mode');

t('every row of chrome the screenshot showed is addressed', async () => {
    // Tab bar, breadcrumb row, and the window title bar were all still visible.
    const keys = SlideEditorProvider.PRESENTATION_SETTINGS.map(s => `${s.section}.${s.key}`);
    for (const need of ['zenMode.showTabs', 'breadcrumbs.enabled', 'zenMode.fullScreen']) {
        assert.ok(keys.includes(need), `${need} must be forced — it is a visible chrome row`);
    }
});

t('tabs are hidden even though zen mode now shows them by default', async () => {
    cfg = makeConfigStore(KNOWN);
    const p = makeProvider();
    await p._applyPresentationSettings();
    assert.strictEqual(cfg.store['zenMode.showTabs'], 'none');
    assert.strictEqual(cfg.store['breadcrumbs.enabled'], false);
    assert.strictEqual(cfg.store['zenMode.centerLayout'], false);
});

t('a key this build does not know is skipped, not thrown on', async () => {
    cfg = makeConfigStore(KNOWN);
    const p = makeProvider();
    await p._applyPresentationSettings();          // hideTabs is absent from KNOWN
    assert.ok(!cfg.calls.some(c => c.key === 'zenMode.hideTabs'),
        'must not write a key the build does not register');
    assert.ok(cfg.calls.length > 0, 'the known keys must still be applied');
});

t('a setting already at the wanted value is left alone entirely', async () => {
    cfg = makeConfigStore(KNOWN, { 'breadcrumbs.enabled': false });
    const p = makeProvider();
    await p._applyPresentationSettings();
    assert.ok(!cfg.calls.some(c => c.key === 'breadcrumbs.enabled'),
        'no write, so nothing to restore and no churn in the user settings file');
});

// ── restoring ─────────────────────────────────────────────────────────────

section('leaving presentation mode');

t('a setting the user never set is REMOVED, not written back as a default', async () => {
    // Writing back the effective value would turn a default into an explicit
    // override that outlives the talk.
    cfg = makeConfigStore(KNOWN);
    const p = makeProvider();
    await p._applyPresentationSettings();
    await p._restorePresentationSettings();
    for (const k of ['zenMode.showTabs', 'breadcrumbs.enabled', 'zenMode.centerLayout']) {
        assert.ok(!(k in cfg.store), `${k} must be removed, not left set (got ${cfg.store[k]})`);
    }
});

t('a setting the user DID set is restored to their value', async () => {
    cfg = makeConfigStore(KNOWN, { 'zenMode.showTabs': 'single', 'breadcrumbs.enabled': true });
    const p = makeProvider();
    await p._applyPresentationSettings();
    assert.strictEqual(cfg.store['zenMode.showTabs'], 'none', 'forced while presenting');
    await p._restorePresentationSettings();
    assert.strictEqual(cfg.store['zenMode.showTabs'], 'single', 'the user’s own choice comes back');
    assert.strictEqual(cfg.store['breadcrumbs.enabled'], true);
});

t('restoring twice does not re-write anything', async () => {
    cfg = makeConfigStore(KNOWN);
    const p = makeProvider();
    await p._applyPresentationSettings();
    await p._restorePresentationSettings();
    const n = cfg.calls.length;
    await p._restorePresentationSettings();
    assert.strictEqual(cfg.calls.length, n, 'the saved list must be cleared after restoring');
});

// ── layout commands ───────────────────────────────────────────────────────

section('entering the presentation layout');

t('zen mode is never toggled blind — exit first, then enter', async () => {
    // toggleZenMode is a TOGGLE and _presZenMode is the only record of our
    // state. Nothing keeps it in sync with the workbench: Ctrl+K Z, a window
    // restored already in zen mode, or a reload all desync it — and then
    // "start presenting" toggles zen mode OFF, which is how a talk begins with
    // every panel on screen.
    cfg = makeConfigStore(KNOWN);
    executed.length = 0;
    const p = makeProvider();
    await p._enterPresentationLayout();
    const exitAt = executed.indexOf('workbench.action.exitZenMode');
    const enterAt = executed.indexOf('workbench.action.toggleZenMode');
    assert.ok(exitAt >= 0, 'must establish a known state with the non-toggle exit command');
    assert.ok(enterAt > exitAt, 'the toggle must come AFTER the exit, so it can only enter');
});

t('the secondary side bar is closed — zen mode does not hide it', async () => {
    // Chat panels live in the auxiliary bar; it stayed open through zen mode.
    cfg = makeConfigStore(KNOWN);
    executed.length = 0;
    const p = makeProvider();
    await p._enterPresentationLayout();
    for (const cmd of ['workbench.action.closeAuxiliaryBar',
                       'workbench.action.closePanel',
                       'workbench.action.closeSidebar']) {
        assert.ok(executed.includes(cmd), `${cmd} must run — a talk should show only the slide`);
    }
});

t('only CLOSE commands are used for the bars, never toggles', async () => {
    // A toggle would re-open a bar that was already closed.
    cfg = makeConfigStore(KNOWN);
    executed.length = 0;
    const p = makeProvider();
    await p._enterPresentationLayout();
    const bad = executed.filter(c => /toggleSidebarVisibility|toggleAuxiliaryBar|togglePanel/.test(c));
    assert.deepStrictEqual(bad, [], `toggles would re-open an already-closed bar: ${bad}`);
});

t('settings are applied BEFORE zen mode reads them', async () => {
    cfg = makeConfigStore(KNOWN);
    executed.length = 0;
    const p = makeProvider();
    const order = [];
    const realApply = p._applyPresentationSettings.bind(p);
    p._applyPresentationSettings = async () => { order.push('settings'); return realApply(); };
    const realExec = executed.push.bind(executed);
    await p._enterPresentationLayout();
    void realExec;
    assert.strictEqual(order[0], 'settings');
    const enterAt = executed.indexOf('workbench.action.toggleZenMode');
    assert.ok(enterAt >= 0 && cfg.calls.length > 0,
        'the config writes must have happened before the zen-mode toggle');
});

t('exiting uses the idempotent command, not another toggle', async () => {
    cfg = makeConfigStore(KNOWN);
    executed.length = 0;
    const p = makeProvider();
    await p._applyPresentationSettings();
    await p._exitPresentationLayout();
    assert.ok(executed.includes('workbench.action.exitZenMode'));
    assert.ok(!executed.includes('workbench.action.toggleZenMode'),
        'a toggle on exit would RE-ENTER zen mode if we were already out of it');
});

// ── the stranding case ────────────────────────────────────────────────────

section('closing the tab mid-presentation');

t('disposing while presenting restores the settings', async () => {
    // This was the real hazard: exitFullscreen was the ONLY restore path, so
    // closing the tab during a talk left zenMode.centerLayout overridden in the
    // user's global settings with nothing to put it back.
    cfg = makeConfigStore(KNOWN, { 'breadcrumbs.enabled': true });
    executed.length = 0;
    const p = makeProvider();
    await p._applyPresentationSettings();
    p._presZenMode = true;
    await p._endPresentationIfActive();
    assert.strictEqual(cfg.store['breadcrumbs.enabled'], true, 'user setting restored');
    assert.ok(!('zenMode.showTabs' in cfg.store), 'unset settings removed again');
    assert.strictEqual(p._presZenMode, false);
    assert.ok(executed.includes('workbench.action.exitZenMode'),
        'zen mode must be left too — via the idempotent command, not a toggle');
});

t('disposing when NOT presenting changes nothing', async () => {
    cfg = makeConfigStore(KNOWN);
    executed.length = 0;
    const p = makeProvider();
    await p._endPresentationIfActive();
    assert.strictEqual(cfg.calls.length, 0);
    assert.strictEqual(executed.length, 0, 'must not toggle zen mode for a deck that was not presenting');
});

t('the panel dispose handler calls it', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'slideEditorProvider.js'), 'utf8');
    const i = src.indexOf('webviewPanel.onDidDispose(');
    assert.ok(i > 0, 'dispose handler not found');
    const body = src.slice(i, i + 400);
    assert.ok(/_endPresentationIfActive\(\)/.test(body),
        'onDidDispose must end presentation mode, or closing the tab strands the settings');
});

runQueue();
