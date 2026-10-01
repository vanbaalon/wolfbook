'use strict';

// Real-time Overleaf editing through Overleaf Workshop (tex/overleafLive.js):
// opt-in behind its risks, and a Workshop local project recognised as one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OverleafLive, workshopReplica, WORKSHOP_ID, ACCEPTED_KEY } = require('../../tex/overleafLive');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fake({ mode = 'git', installed = false, answer } = {}) {
    const calls = { warnings: [], info: [], commands: [], updates: [] };
    let current = mode;
    const store = new Map();
    const vscode = {
        workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'overleafSync' ? current : d),
            update: async (k, v) => { calls.updates.push([k, v]); current = v; } }) },
        window: {
            createStatusBarItem: () => ({ text: '', tooltip: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }),
            showWarningMessage: async (m, opts, ...items) => { calls.warnings.push({ m, opts }); return answer === 'accept' ? items[0] : undefined; },
            showInformationMessage: async (m, ...items) => { calls.info.push(m); return items[0]; },
            showErrorMessage: async () => undefined,
        },
        extensions: { getExtension: id => (installed && id === WORKSHOP_ID ? {} : undefined) },
        commands: { executeCommand: async (...a) => { calls.commands.push(a); } },
        StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1 },
    };
    const context = { globalState: { get: k => store.get(k), update: async (k, v) => { store.set(k, v); } } };
    return { vscode, context, calls, store, mode: () => current };
}

test('a file inside an Overleaf Workshop local project is recognised, with its project name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-replica-'));
    fs.mkdirSync(path.join(root, '.overleaf'));
    fs.writeFileSync(path.join(root, '.overleaf', 'settings.json'), JSON.stringify({ projectName: 'Fishnets', serverName: 'www.overleaf.com' }));
    fs.mkdirSync(path.join(root, 'sections'));
    const r = workshopReplica(path.join(root, 'sections', 'one.tex'));
    assert.strictEqual(r.root, root);
    assert.strictEqual(r.projectName, 'Fishnets');
    assert.strictEqual(workshopReplica(path.join(os.tmpdir(), 'elsewhere', 'main.tex')), null);
});

test('choosing "live" in the settings is undone unless its risks are accepted', async () => {
    const f = fake({ mode: 'live' });
    const live = new OverleafLive({ vscode: f.vscode, context: f.context, target: () => null });
    await live.configurationChanged();
    assert.strictEqual(f.calls.warnings.length, 1, 'the risks are shown');
    assert.ok(/not supported by Overleaf/.test(f.calls.warnings[0].m));
    assert.ok(/terms forbid/.test(f.calls.warnings[0].opts.detail), 'the terms are named');
    assert.strictEqual(f.mode(), 'git', 'declined: back to Git sync');
    const g = fake({ mode: 'live', answer: 'accept' });
    const ok = new OverleafLive({ vscode: g.vscode, context: g.context, target: () => null });
    await ok.configurationChanged();
    assert.strictEqual(g.mode(), 'live');
    assert.strictEqual(g.store.get(ACCEPTED_KEY), true);
    await ok.configurationChanged();
    assert.strictEqual(g.calls.warnings.length, 1, 'asked once');
});

test('the live command links an unlinked paper, and connects a linked one — never without the risks', async () => {
    const f = fake({ answer: 'accept' });
    const live = new OverleafLive({ vscode: f.vscode, context: f.context, target: () => '/p/PAPER/main.tex' });
    const calls = [];
    live.link.link = async file => { calls.push(['link', file]); return true; };
    live.link.connect = async root => { calls.push(['connect', root]); return true; };
    assert.strictEqual(await live.start(), true);
    assert.deepStrictEqual(calls, [['link', '/p/PAPER/main.tex']]);
    assert.strictEqual(f.mode(), 'live');
    f.store.set('wolfbook.tex.overleafLinks', { '/p/PAPER': { url: 'https://www.overleaf.com/project/0123456789abcdef01234567', projectName: 'Fishnets' } });
    await live.start();
    assert.deepStrictEqual(calls.at(-1), ['connect', '/p/PAPER'], 'a linked paper (by its folder) connects');
    const h = fake({ answer: undefined });
    const no = new OverleafLive({ vscode: h.vscode, context: h.context, target: () => '/p/main.tex' });
    no.link.link = async () => { throw Error('must not link'); };
    assert.strictEqual(await no.start(), false, 'nothing without the risks accepted');
});

test('Git auto-sync leaves an Overleaf Workshop local project alone', async () => {
    const { OverleafAutoSync } = require('../../tex/overleafSync');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-replica-'));
    fs.mkdirSync(path.join(root, '.overleaf'));
    fs.writeFileSync(path.join(root, '.overleaf', 'settings.json'), '{}');
    let synced = 0;
    const vscode = { workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
        window: { createStatusBarItem: () => null }, StatusBarAlignment: { Left: 1 } };
    const sync = new OverleafAutoSync({ vscode, git: { autoSync: async () => { synced++; return { status: 'synced' }; } },
        target: () => path.join(root, 'main.tex'), now: () => 1e9 });
    assert.strictEqual(await sync.tick(), null);
    assert.strictEqual(synced, 0);
});

test('the Overleaf control lists the ways to stay in step and switches between them (live only after its risks)', async () => {
    const { overleafMenu } = require('../../tex/overleafMenu');
    const f = fake({ mode: 'git' });
    let shown = null; let choose = null;
    f.vscode.window.showQuickPick = async (items) => { shown = items; return items.find(i => choose && choose.test(i.label)); };
    f.vscode.QuickPickItemKind = { Separator: -1 };
    const live = new OverleafLive({ vscode: f.vscode, context: f.context, target: () => '/p/main.tex' });
    const git = { context: { secrets: { get: async () => 'tok' } }, _repo: async () => '/p',
        _findOverleafRemote: async () => ({ name: 'overleaf', url: 'https://git.overleaf.com/abc' }),
        _secretKey: () => 'k', configureOverleaf: async () => { git.configured = true; } };
    let synced = 0;
    const sync = { run: async () => { synced++; } };
    const o = { vscode: f.vscode, sync, live, git, target: () => '/p/main.tex' };
    choose = /Sync with Overleaf now/;
    await overleafMenu(o);
    assert.strictEqual(synced, 1);
    const labels = shown.map(i => i.label).join('\n');
    assert.ok(/check\) Git, every 5 minutes/.test(labels), 'Git is the current choice');
    assert.ok(/Real time, as in the Overleaf editor/.test(labels));
    assert.ok(shown.some(i => /not supported by Overleaf/.test(i.description || '')), 'the risk is on the item');
    choose = /Real time/;
    await overleafMenu(o);
    assert.strictEqual(f.mode(), 'git', 'declined risks: nothing changes');
    choose = /^\$\(blank\) Off/;
    await overleafMenu(o);
    assert.strictEqual(f.mode(), 'off');
    choose = /Connect this paper/;
    f.vscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'overleafSync' ? 'git' : d), update: async () => {} });
    await overleafMenu(o);
    assert.strictEqual(git.configured, true);
});

test('the leaf says whether the paper is in step with Overleaf, and with which project and file', async () => {
    const f = fake({ mode: 'live', answer: 'accept' });
    const live = new OverleafLive({ vscode: f.vscode, context: f.context, target: () => '/p/PAPER/sections/a.tex' });
    f.store.set('wolfbook.tex.overleafLinks', { '/p/PAPER': { url: 'https://www.overleaf.com/project/0123456789abcdef01234567', projectName: 'Fishnets' } });
    assert.deepStrictEqual(live.info('/p/PAPER/sections/a.tex'), { connected: false, title: 'Overleaf: linked to “Fishnets” — not connected' });
    live.link.root = '/p/PAPER'; live.link.state = { status: 'connected', project: 'Fishnets', detail: '2 documents in step with Overleaf' };
    const i = live.info('/p/PAPER/sections/a.tex');
    assert.strictEqual(i.connected, true);
    assert.strictEqual(i.title, 'Connected to Overleaf in real time: “Fishnets” — sections/a.tex');
    const { OverleafAutoSync } = require('../../tex/overleafSync');
    const vscode = { workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, StatusBarAlignment: { Left: 1 },
        window: { createStatusBarItem: () => null, showInformationMessage: async () => undefined } };
    const sync = new OverleafAutoSync({ vscode, git: { autoSync: async () => ({ status: 'synced', repo: '/r' }) }, target: () => '/r/paper/main.tex', now: () => Date.UTC(2026, 8, 30, 12, 5) });
    assert.strictEqual(sync.info('/r/paper/main.tex').connected, false, 'nothing synced yet');
    await sync.run('/r/paper/main.tex', { manual: true });
    const g = sync.info('/r/paper/main.tex');
    assert.strictEqual(g.connected, true);
    assert.ok(/^Synced with Overleaf through Git at .* — paper\/main\.tex \(every 5 min\)$/.test(g.title), g.title);
});

(async () => {
    console.log('WPaper Overleaf live\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`  ok   ${name}`); }
        catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.stack || e}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
