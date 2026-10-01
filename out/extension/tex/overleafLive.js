'use strict';

// OVERLEAF, IN REAL TIME — `wolfbook.tex.overleafSync: "live"`, off unless
// the reader chooses it and accepts its risks.
//
// The paper's folder is linked to an Overleaf project and edited in place
// (overleafLink.js): WPaper connects the way Overleaf's web editor does,
// signed in with the reader's session cookie. The risks are Overleaf's
// terms, which do not support this. A folder Overleaf Workshop made
// (`.overleaf/settings.json`) is still recognised, so that Git auto-sync
// leaves it to Workshop.

const fs = require('fs');
const path = require('path');
const { OverleafLink } = require('./overleafLink');

const WORKSHOP_ID = 'iamhyc.overleaf-workshop';
const ACCEPTED_KEY = 'wolfbook.tex.overleafLiveRisksAccepted';

const LIVE_RISKS = [
    'Overleaf does not support this. WPaper connects to overleaf.com the way Overleaf\'s web editor does, signed in with your browser\'s session cookie, instead of through Git.',
    'Overleaf\'s terms forbid access other than through its publicly supported interfaces. Using it may breach them, and Overleaf could restrict or close your account.',
    'It can stop working at any time, without notice, when Overleaf changes its editor. If the connection drops, connect again: differences are then offered for you to resolve.',
    'Your session cookie gives full access to your Overleaf account. It is kept in VS Code Secret Storage and sent only to Overleaf.',
    'You appear as yourself in the project: collaborators see what you type as you type it, and theirs appears in your editor.',
];

/** The Overleaf Workshop local project that holds `file`, if any. */
function workshopReplica(file, { exists = fs.existsSync, read = f => fs.readFileSync(f, 'utf8') } = {}) {
    let dir = path.dirname(path.resolve(file));
    for (let i = 0; i < 40; i++) {
        const marker = path.join(dir, '.overleaf', 'settings.json');
        if (exists(marker)) {
            let settings = {};
            try { settings = JSON.parse(read(marker)) || {}; } catch (_) { /* a marker is enough */ }
            return { root: dir, projectName: settings.projectName || path.basename(dir),
                serverName: settings.serverName || null };
        }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

class OverleafLive {
    constructor({ vscode, context, target, log = () => {}, deps = null }) {
        this.vscode = vscode;
        this.context = context;
        this.target = target;
        this.log = log;
        this.link = new OverleafLink({ vscode, context, log, deps });
        this.link.onState = () => this.refresh();
        this.tried = new Set();
        this.status = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment.Left, 40) || null;
        if (this.status) this.status.command = 'wolfbook.tex.overleafMenu';
    }

    mode() { return this.vscode.workspace.getConfiguration('wolfbook.tex').get('overleafSync', 'git'); }
    accepted() { return this.context.globalState?.get(ACCEPTED_KEY) === true; }
    installed() { return !!this.vscode.extensions?.getExtension?.(WORKSHOP_ID); }

    /** The risks, once: true when the reader accepts them. */
    async acceptRisks() {
        if (this.accepted()) return true;
        const yes = 'I understand — use at my own risk';
        const pick = await this.vscode.window.showWarningMessage(
            'Real-time Overleaf editing is not supported by Overleaf',
            { modal: true, detail: LIVE_RISKS.map(r => `• ${r}`).join('\n\n') }, yes);
        if (pick !== yes) return false;
        await this.context.globalState?.update(ACCEPTED_KEY, true);
        return true;
    }

    /**
     * The setting was changed (Settings UI, settings.json): "live" is only
     * kept once its risks are accepted; declined, the choice goes back to Git.
     */
    async configurationChanged() {
        if (this.mode() === 'live' && !(await this.acceptRisks())) {
            await this.vscode.workspace.getConfiguration('wolfbook.tex')
                .update('overleafSync', 'git', this.vscode.ConfigurationTarget.Global);
        }
        if (this.mode() !== 'live') this.link.disconnect();
        this.refresh();
    }

    /** The command: real time on, and this paper linked (or connected, when it is). */
    async start() {
        if (!(await this.acceptRisks())) return false;
        if (this.mode() !== 'live') {
            await this.vscode.workspace.getConfiguration('wolfbook.tex')
                .update('overleafSync', 'live', this.vscode.ConfigurationTarget.Global);
        }
        const file = this.target();
        if (!file) { this.vscode.window.showInformationMessage('Open the paper\'s .tex file first.'); return false; }
        const linked = this.link.linkFor(file);
        const ok = linked ? await this.link.connect(linked.root) : await this.link.link(file);
        if (!ok && this.link.state.detail) this.vscode.window.showWarningMessage(`Overleaf: ${this.link.state.detail}`);
        this.refresh();
        return ok;
    }

    /** The status item for the paper in view; a linked paper connects once by itself. */
    refresh() {
        const file = this.target();
        const linked = this.mode() === 'live' && file ? this.link.linkFor(file) : null;
        if (linked && !this.link.client && !this.tried.has(linked.root)) {
            this.tried.add(linked.root);
            // Only with a cookie already kept: nothing is asked unprompted.
            parseBase(linked.url).then(base => base && this.link.cookie(base, { ask: false })).then(c => {
                if (c) return this.link.connect(linked.root);
            }).catch(() => {});
        }
        try { this.onPaint?.(); } catch (_) { /* the leaf is a courtesy */ }
        if (!this.status) return;
        if (this.mode() !== 'live' || !file) { this.status.hide(); return; }
        const s = this.link.state;
        this.status.color = undefined;
        if (linked && this.link.root === linked.root && s.status === 'connected') {
            this.status.text = '$(broadcast) Overleaf live';
            this.status.tooltip = `${this.info(file).title}\n${s.detail}. Not supported by Overleaf.`;
            this.status.color = this.vscode.ThemeColor ? new this.vscode.ThemeColor('testing.iconPassed') : undefined;
        } else if (linked && this.link.root === linked.root && s.status === 'connecting') {
            this.status.text = '$(sync~spin) Overleaf';
            this.status.tooltip = 'Connecting to Overleaf…';
        } else if (linked) {
            this.status.text = '$(broadcast) Overleaf: connect';
            this.status.tooltip = `${linked.projectName ? `Linked to “${linked.projectName}”. ` : ''}${s.status === 'error' && this.link.root === linked.root ? s.detail : 'Not connected'} — click`;
        } else {
            this.status.text = '$(broadcast) Overleaf: link this paper';
            this.status.tooltip = 'This paper is not linked to an Overleaf project — click';
        }
        this.status.show();
    }

    /**
     * What the leaf says about the paper in view: whether it is connected to
     * Overleaf in real time, and to which project and file there.
     */
    info(file) {
        const linked = this.mode() === 'live' && file ? this.link.linkFor(file) : null;
        const s = this.link.state;
        if (linked && this.link.root === linked.root && s.status === 'connected') {
            const rel = path.relative(linked.root, path.resolve(file)).split(path.sep).join('/');
            return { connected: true, project: s.project, file: rel,
                title: `Connected to Overleaf in real time: “${s.project}” — ${rel}` };
        }
        return { connected: false,
            title: linked ? `Overleaf: linked to “${linked.projectName || linked.url}” — not connected` : 'Overleaf — how this paper stays in step with it' };
    }

    dispose() { this.link.dispose(); this.status?.dispose?.(); }
}

async function parseBase(url) {
    try { return require('./overleafClient').parseProjectUrl(url).base; } catch (_) { return null; }
}

module.exports = { OverleafLive, workshopReplica, LIVE_RISKS, WORKSHOP_ID, ACCEPTED_KEY };
