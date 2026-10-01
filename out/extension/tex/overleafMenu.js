'use strict';

// THE OVERLEAF CONTROL — the Overleaf icon in the editor's title bar and in
// WPaper's toolbar: how the paper is kept in step with Overleaf, and every
// action of that choice, in one menu.

const { WORKSHOP_ID } = require('./overleafLive');

/**
 * @param {object} o
 * @param {object} o.vscode
 * @param {import('./overleafSync').OverleafAutoSync} o.sync
 * @param {import('./overleafLive').OverleafLive} o.live
 * @param {import('./gitWorkflow').GitWorkflow} o.git
 * @param {() => string|undefined} o.target
 */
async function overleafMenu({ vscode, sync, live, git, target }) {
    const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
    const mode = cfg.get('overleafSync', 'git');
    const minutes = cfg.get('overleafSyncMinutes', 5);
    const file = target();
    const linked = file ? live.link.linkFor(file) : null;
    const ls = live.link.state;
    const connectedHere = linked && live.link.root === linked.root && ls.status === 'connected';
    let remote = null, repo = null, hasToken = false;
    if (file) {
        try {
            repo = await git._repo(file, false);
            remote = repo ? await git._findOverleafRemote(repo) : null;
            hasToken = !!(remote && git.context.secrets && await git.context.secrets.get(git._secretKey(repo, remote.name)));
        } catch (_) { /* not a repository */ }
    }
    const tick = on => (on ? '$(check) ' : '$(blank) ');
    const status = mode === 'git'
        ? (remote ? `${remote.url.replace(/(https?:\/\/)[^/@]+@/, '$1')}${hasToken ? '' : ' — needs a Git token'}` : 'No Overleaf Git remote for this paper')
        : mode === 'live'
            ? (connectedHere ? `Live with “${ls.project}” — ${ls.detail}`
                : linked ? `Linked to ${linked.projectName ? `“${linked.projectName}”` : linked.url} — not connected${ls.status === 'error' && live.link.root === linked.root ? ` (${ls.detail})` : ''}`
                    : 'This paper is not linked to an Overleaf project')
            : 'Off';
    const items = [
        { label: 'Overleaf', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
        { label: `$(info) ${status}`, action: null },
    ];
    if (mode === 'git' && remote && hasToken) items.push({ label: '$(sync) Sync with Overleaf now', action: 'sync' });
    items.push(
        { label: 'How this paper stays in step', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
        { label: `${tick(mode === 'git')}Git, every ${minutes} minutes`, description: 'default · paid Overleaf plan, Git token', action: 'mode:git' },
        { label: `${tick(mode === 'live')}Real time, as in the Overleaf editor`, description: 'not supported by Overleaf · at your own risk', action: 'mode:live' },
        { label: `${tick(mode === 'off')}Off`, description: 'commit and push yourself', action: 'mode:off' },
    );
    if (mode === 'git') {
        items.push(
            { label: 'Git', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
            { label: '$(plug) Connect this paper to an Overleaf project…', description: 'its Git address', action: 'configure' },
            ...(remote ? [{ label: `$(key) ${hasToken ? 'Replace' : 'Add'} the Overleaf Git token…`, action: 'token' }] : []),
            { label: `$(clock) Sync every… (now ${minutes} min)`, action: 'minutes' },
        );
    }
    if (mode === 'live') {
        items.push(
            { label: 'Real time', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
            ...(linked
                ? [connectedHere ? { label: '$(debug-disconnect) Disconnect', action: 'disconnect' } : { label: '$(plug) Connect', action: 'live' },
                    { label: '$(link) Link to another project…', action: 'relink' },
                    { label: '$(close) Unlink this paper', action: 'unlink' }]
                : [{ label: '$(link) Link this paper to an Overleaf project…', description: 'its folder, edited in place', action: 'live' }]),
            { label: '$(key) Set the Overleaf session cookie…', action: 'cookie' },
        );
    }
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Overleaf', placeHolder: 'How this paper stays in step with Overleaf',
    });
    if (!pick || !pick.action) return;
    const setMode = async m => {
        if (m === 'live') {
            if (!(await live.acceptRisks())) return false;
        }
        await cfg.update('overleafSync', m, vscode.ConfigurationTarget.Global);
        live.refresh();
        return true;
    };
    switch (pick.action) {
    case 'sync': if (file) await sync.run(file, { manual: true }); break;
    case 'mode:git': await setMode('git'); break;
    case 'mode:off': await setMode('off'); break;
    case 'mode:live': if (await setMode('live') && !connectedHere) await live.start(); break;
    case 'configure': if (file) await git.configureOverleaf(file); break;
    case 'token':
        if (repo && remote && await git._promptOverleafToken(repo, remote.name) && file) await sync.run(file, { manual: true });
        break;
    case 'minutes': {
        const v = await vscode.window.showInputBox({ title: 'Sync with Overleaf every … minutes', value: String(minutes),
            validateInput: s => (/^\d+$/.test(s) && +s >= 1 && +s <= 120 ? null : 'A whole number of minutes, 1 to 120') });
        if (v) await cfg.update('overleafSyncMinutes', Number(v), vscode.ConfigurationTarget.Global);
        break;
    }
    case 'live': await live.start(); break;
    case 'disconnect': live.link.disconnect(); break;
    case 'relink': if (file) await live.link.link(file); break;
    case 'unlink': if (linked) await live.link.unlink(linked.root); break;
    case 'cookie': {
        const base = linked ? new URL(linked.url).origin : 'https://www.overleaf.com';
        await live.link.askCookie(base);
        break;
    }
    }
}

module.exports = { overleafMenu, WORKSHOP_ID };
