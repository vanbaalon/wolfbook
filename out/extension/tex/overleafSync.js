'use strict';

// OVERLEAF AUTO-SYNC — the default way a paper cloned from Overleaf stays in
// step with it (`wolfbook.tex.overleafSync: "git"`).
//
// Every `overleafSyncMinutes` (5 by default), once typing has paused, the
// paper's repository is committed, merged with what collaborators pushed
// and pushed back through Overleaf's Git integration (GitWorkflow.autoSync).
// It needs the project's Overleaf remote and a Git authentication token in
// Secret Storage: without the token it asks once, and does nothing until one
// is given. A conflict is never left in the files: the merge is aborted,
// auto-sync pauses for that repository, and the reader is offered the
// ordinary push, which leaves the conflicting sections open to resolve.
//
// The other choice, "live", is Overleaf's real-time editing through the
// separately installed Overleaf Workshop extension (overleafLive.js); "off"
// leaves Git alone.

const { workshopReplica, overleafConfiguration } = require('./overleafLive');

const IDLE_MS = 20000;          // no auto-commit in the middle of a sentence
const TICK_MS = 30000;

class OverleafAutoSync {
    /**
     * @param {object} o
     * @param {object} o.vscode
     * @param {import('./gitWorkflow').GitWorkflow} o.git
     * @param {() => string|undefined} o.target   a file of the paper in view
     * @param {(line: string) => void} [o.log]
     * @param {() => number} [o.now]
     */
    constructor({ vscode, git, target, log = () => {}, now = () => Date.now() }) {
        this.vscode = vscode;
        this.git = git;
        this.target = target;
        this.log = log;
        this.now = now;
        this.lastEditAt = 0;
        this.lastRun = new Map();       // repo -> ms
        this.paused = new Map();        // repo -> reason
        this.askedToken = new Set();    // repo
        this.running = false;
        this.timer = null;
        this.last = new Map();          // repo -> the last auto-sync's result
        this.status = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment.Left, 40) || null;
        if (this.status) this.status.command = 'wolfbook.tex.overleafSyncNow';
    }

    config() {
        const cfg = overleafConfiguration(this.vscode, this.target()).config;
        const mode = cfg.get('overleafSync', 'git');
        const minutes = Math.max(1, Math.min(120, Number(cfg.get('overleafSyncMinutes', 5)) || 5));
        return { mode, everyMs: minutes * 60000 };
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => { this.tick().catch(error => this.log(`overleaf auto-sync: ${error.message}`)); }, TICK_MS);
        this.timer.unref?.();
    }

    dispose() {
        clearInterval(this.timer);
        this.timer = null;
        this.status?.dispose?.();
    }

    noteEdit() { this.lastEditAt = this.now(); }

    /** The timer's turn: sync the paper in view when it is due and typing has paused. */
    async tick() {
        const { mode, everyMs } = this.config();
        if (mode !== 'git' || this.running) return null;
        if (this.now() - this.lastEditAt < IDLE_MS) return null;
        const file = this.target();
        if (!file) return null;
        // An Overleaf Workshop local project is kept in step by Workshop.
        if (workshopReplica(file)) return null;
        return this.run(file, { due: everyMs });
    }

    /**
     * Sync now (the status item, the command), or when due. A manual run
     * also resumes a repository paused by a conflict or a refused token.
     */
    async run(file, { due = 0, manual = false } = {}) {
        if (this.running) return null;
        this.running = true;
        let result;
        let repoKey;
        try {
            // Pause and schedule are per REPOSITORY — autoSync works on the
            // whole repo, so keying by the file in view re-ran a paused
            // conflict for every other file of the paper.
            try { repoKey = (await this.git._repo?.(file, false)) || file; } catch (_) { repoKey = file; }
            const last = this.lastRun.get(repoKey) || 0;
            if (!manual && (this.paused.has(repoKey) || this.now() - last < due)) return null;
            if (manual) this.paused.delete(repoKey);
            this.lastRun.set(repoKey, this.now());
            this._show('$(sync~spin) Overleaf', 'Syncing with Overleaf…');
            result = await this.git.autoSync(file);
            this.log(`overleaf auto-sync: ${result.status}${result.detail ? ` — ${result.detail}` : ''}`);
            if (result.repo) this.last.set(result.repo, { ...result, at: this.now() });
            try { this.onPaint?.(); } catch (_) { /* a courtesy */ }
        } finally {
            this.running = false;
        }
        // Reported AFTER the run is over: a notification left unanswered must
        // not hold `running` (it stopped every later sync), and the retry
        // after "Add token" must not find a run still in progress.
        this._report(file, result, manual, repoKey).catch(error => this.log(`overleaf auto-sync: ${error.message}`));
        return result;
    }

    async _report(file, r, manual, repoKey = file) {
        const key = file;
        const at = new Date(this.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const w = this.vscode.window;
        switch (r.status) {
        case 'synced':
        case 'nothing':
            this._show(`$(check) Overleaf ${at}`, `Synced with Overleaf at ${at}` +
                (r.committed ? ` · committed ${r.committed}` : '') + (r.pulled ? ' · merged collaborators’ changes' : '') +
                (r.pushed ? ' · pushed' : '') + ' — click to sync now');
            if (manual) w.showInformationMessage(r.status === 'nothing' ? 'Overleaf: already in sync.' : 'Overleaf: synced.');
            return;
        case 'no-remote':
        case 'no-repo':
            this._hide();
            if (manual) w.showInformationMessage('This paper has no Overleaf Git remote. Use “WPaper: Configure Overleaf Git Sync”.');
            return;
        case 'no-token': {
            this._show('$(key) Overleaf', 'Overleaf auto-sync needs a Git authentication token — click to add it');
            if (!manual && this.askedToken.has(r.repo)) return;
            this.askedToken.add(r.repo);
            const add = 'Add token';
            const off = 'Turn auto-sync off';
            const pick = await w.showInformationMessage(
                'Overleaf auto-sync commits, merges and pushes this paper every few minutes. It needs an Overleaf Git authentication token (Overleaf → Account settings → Git integration).',
                add, off);
            if (pick === add && await this.git._promptOverleafToken(r.repo, r.remote)) this.run(key, { manual: true });
            if (pick === off) await this._turnOff();
            return;
        }
        case 'conflict': {
            this.paused.set(repoKey, 'conflict');
            this._show('$(warning) Overleaf', 'Auto-sync paused: your changes and a collaborator’s overlap — click to sync now');
            const resolve = 'Merge and resolve now';
            const pick = await w.showWarningMessage(
                `Overleaf auto-sync paused: a collaborator changed the same lines (${r.files.slice(0, 4).join(', ')}${r.files.length > 4 ? ', …' : ''}). Nothing was lost — your work is committed locally.`,
                resolve);
            if (pick === resolve) await this.git.push(key, { repo: r.repo, remote: r.remote, remoteBranch: 'master' });
            return;
        }
        case 'auth':
            this.paused.set(repoKey, 'auth');
            this._show('$(key) Overleaf', 'Overleaf refused the Git token — click to retry');
            if ((await w.showWarningMessage('Overleaf refused the Git authentication token; auto-sync paused.', 'Replace token')) === 'Replace token' &&
                await this.git._promptOverleafToken(r.repo, r.remote)) this.run(key, { manual: true });
            return;
        case 'merging':
            this.paused.set(repoKey, 'merging');
            this._show('$(warning) Overleaf', 'Auto-sync waits: finish the merge in progress, then click');
            return;
        case 'no-identity':
            this.paused.set(repoKey, 'identity');
            this._show('$(warning) Overleaf', 'Auto-sync needs a Git author name and email (commit once with “WPaper: Commit Changes”)');
            return;
        case 'detached':
            this.paused.set(repoKey, 'detached');
            this._show('$(warning) Overleaf', 'Auto-sync waits: check out a branch');
            return;
        default:
            this._show('$(warning) Overleaf', `Overleaf auto-sync failed: ${r.detail || r.status} — click to retry`);
        }
    }

    /** What the leaf says in Git mode: synced (green) when the last auto-sync of this paper's repository went through. */
    info(file) {
        const path = require('path');
        for (const [repo, r] of this.last) {
            const rel = file && path.relative(repo, path.resolve(file));
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
            const at = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (r.status === 'synced' || r.status === 'nothing') return { connected: true,
                title: `Synced with Overleaf through Git at ${at} — ${rel.split(path.sep).join('/')} (every ${this.config().everyMs / 60000} min)` };
            return { connected: false, title: `Overleaf (Git): ${r.status}${r.detail ? ` — ${r.detail}` : ''}` };
        }
        return { connected: false, title: 'Overleaf — how this paper stays in step with it' };
    }

    async _turnOff() {
        const { config, scope } = overleafConfiguration(this.vscode, this.target());
        await config.update('overleafSync', 'off', scope);
        this._hide();
    }

    _show(text, tooltip) {
        if (!this.status) return;
        this.status.text = text;
        this.status.tooltip = tooltip;
        this.status.show();
    }

    _hide() { this.status?.hide(); }
}

module.exports = { OverleafAutoSync, IDLE_MS };
