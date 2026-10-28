'use strict';

// Sidebar entry point: bring an entire project onto disk, then use the same
// WPaper/live/Git editing paths as an ordinary local paper. Never push on open.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { OverleafLiveClient, parseProjectUrl } = require('./overleafClient');
const { LINKS_KEY, cookieKey } = require('./overleafLink');
const { parseOverleafConnection } = require('./gitWorkflow');
const BASE = 'https://www.overleaf.com';
const RECENT_KEY = 'wolfbook.tex.overleafOpenedProjects';
const PENDING_KEY = 'wolfbook.tex.overleafPendingOpen';

function safeRemotePath(value) {
    const name = String(value || '');
    const parts = name.split('/');
    if (!name || /[\\:\x00-\x1f]/.test(name) || parts.some(p => !p || p === '.' || p === '..' || /^\.(git|overleaf)$/i.test(p))) {
        throw Error('The project contains an unsafe file path.');
    }
    return parts.join('/');
}

async function texFiles(root) {
    const files = [];
    async function walk(dir) {
        for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
            if (item.name.startsWith('.')) continue;
            const file = path.join(dir, item.name);
            if (item.isDirectory()) await walk(file);
            else if (item.isFile() && /\.tex$/i.test(item.name)) files.push(path.relative(root, file).split(path.sep).join('/'));
        }
    }
    await walk(root);
    return files.sort();
}

async function mainFile(root, files) {
    const ordered = [...files].sort((a, b) => a === 'main.tex' ? -1 : b === 'main.tex' ? 1 : a.localeCompare(b));
    for (const name of ordered) {
        const text = await fs.promises.readFile(path.join(root, ...safeRemotePath(name).split('/')), 'utf8');
        if (/\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(text.replace(/^\s*%.*$/gm, ''))) return name;
    }
    return null;
}

async function deadline(task, label, ms = 60000) {
    let timer;
    try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out. Please try again.`)), ms); })]); }
    finally { clearTimeout(timer); }
}

class OverleafConnector {
    constructor({ vscode, context, live, git, deps = {} }) {
        Object.assign(this, { vscode, context, live, git });
        this.makeClient = deps.makeClient || (() => new OverleafLiveClient({ remote() {}, tree() {}, closed() {}, fileChanged() {}, docAdded() {} }, live.link.deps));
        this.fetch = deps.fetch || live.link.deps.fetch;
        this.state = { projects: [], account: 'disconnected', detail: 'Connect your account to browse projects.' };
        this.busy = false;
    }

    async status({ refresh = false } = {}) {
        const cookie = await this.live.link.cookie(BASE, { ask: false });
        if (!cookie) this.state = { projects: [], account: 'disconnected', detail: 'Connect your account to browse projects.' };
        else if (refresh && !this.busy) {
            try {
                const projects = await deadline(this.live.link.projects(BASE, cookie, { strict: true }), 'Loading Overleaf projects', 20000);
                this.state = { account: 'connected', detail: projects.length ? 'Choose a project to open in WPaper.' : 'No editable projects found in this account.',
                    projects: projects.filter(p => /^[a-f0-9]{24}$/i.test(p._id)).map(p => ({ id: p._id, name: String(p.name || 'Untitled project'), access: String(p.accessLevel || '') })) };
            } catch (error) { this.state = { account: 'error', projects: [], detail: error.message }; }
        } else if (this.state.account === 'disconnected') this.state = { ...this.state, account: 'saved', detail: 'Session saved. Refresh to load your projects.' };
        return { ...this.state, busy: this.busy, recent: this.recent(), live: this.live.info(this.live.target()) };
    }

    recent() {
        return (this.context.globalState?.get(RECENT_KEY) || []).filter(p => p && typeof p.root === 'string' && fs.existsSync(p.root)).slice(0, 12);
    }

    async connectAccount() {
        if (!(await this.live.acceptRisks())) return false; // existing live connector consent, once
        if (!(await this.live.link.askCookie(BASE))) return false;
        await this.status({ refresh: true });
        return this.state.account === 'connected';
    }

    async disconnectAccount() {
        // Disconnect the transport; local projects and edits remain available.
        this.live.link.disconnect();
        await this.context.secrets?.delete(cookieKey(BASE));
        this.state = { projects: [], account: 'disconnected', detail: 'Account disconnected. Local projects are kept.' };
        this.live.refresh();
    }

    async _folder(name) {
        const selected = await this.vscode.window.showOpenDialog({ title: 'Choose where to keep the local Overleaf project',
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Create project here',
            defaultUri: this.vscode.workspace.workspaceFolders?.[0]?.uri || this.vscode.Uri.file(path.join(os.homedir(), 'Documents')) });
        if (!selected?.[0]) return null;
        const parent = await fs.promises.realpath(selected[0].fsPath);
        const stem = String(name).replace(/[^\p{L}\p{N}._ -]/gu, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'Overleaf project';
        for (let n = 0; n < 1000; n++) {
            const root = path.join(parent, stem + (n ? `-${n + 1}` : ''));
            try { await fs.promises.mkdir(root); return root; }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        throw Error('Choose another folder for this project.');
    }

    async _chooseFile(files, name, main) {
        const choices = files.filter(f => /\.tex$/i.test(f));
        if (!choices.length) throw Error('This project contains no .tex files to open in WPaper.');
        choices.sort((a, b) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
        const pick = await this.vscode.window.showQuickPick(choices.map(file => ({ label: file, description: file === main ? 'Main document' : '', file })),
            { title: `Open a file from “${name}”`, placeHolder: 'The complete project is kept locally for WPaper and AI agents', matchOnDescription: true });
        return pick?.file || null;
    }

    async _remember(project) {
        await this.context.globalState?.update(RECENT_KEY, [project, ...this.recent().filter(p => p.root !== project.root)].slice(0, 12));
    }

    async _show(project, file) {
        // Put the actual project in the workspace so agents edit its sources.
        // VS Code restarts its extension host when adding the FIRST folder;
        // persist that handoff and resume only after commands are registered.
        const folders = this.vscode.workspace.workspaceFolders || [];
        const covered = folders.some(f => path.resolve(f.uri.fsPath) === path.resolve(project.root));
        if (!covered && this.vscode.workspace.updateWorkspaceFolders) {
            if (!folders.length) {
                await this.context.globalState.update(PENDING_KEY, { ...project, file });
                const added = this.vscode.workspace.updateWorkspaceFolders(0, 0, { uri: this.vscode.Uri.file(project.root), name: project.name });
                if (!added) { await this.context.globalState.update(PENDING_KEY, undefined); throw Error('The local project is ready, but VS Code could not open its workspace folder.'); }
                return false; // activation resumes opening; never connect before handoff
            }
            let ready;
            const change = this.vscode.workspace.onDidChangeWorkspaceFolders?.(() => ready?.());
            try {
                const wait = new Promise(resolve => { ready = resolve; });
                const added = this.vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: this.vscode.Uri.file(project.root), name: project.name });
                if (!added) throw Error('The local project is ready, but VS Code could not add its folder to the workspace.');
                if (!this.vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === project.root) && change) await deadline(wait, 'Adding the project folder', 10000);
            } finally { change?.dispose(); }
        }
        await this.vscode.workspace.getConfiguration('wolfbook.tex', this.vscode.Uri.file(project.root))
            .update('overleafSync', project.mode, this.vscode.ConfigurationTarget.WorkspaceFolder);
        const doc = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(path.join(project.root, ...safeRemotePath(file).split('/'))));
        await this.vscode.window.showTextDocument(doc, { preview: false });
        // Use the selected file as the sync root when no main document is known.
        // Opening/compiling does not publish any edits.
        await this.vscode.commands.executeCommand('wolfbook.tex.openViewer', project.main ? { root: path.join(project.root, ...safeRemotePath(project.main).split('/')) } : undefined);
        return true;
    }

    async _progress(title, fn) {
        if (this.vscode.window.withProgress) return this.vscode.window.withProgress({ location: this.vscode.ProgressLocation.Notification, title, cancellable: false }, fn);
        return fn({ report() {} });
    }

    async openLive(projectId) {
        if (this.busy) return false;
        this.busy = true;
        let client, root, imported = false;
        try {
            if (!(await this.live.acceptRisks())) return false;
            const cookie = await this.live.link.cookie(BASE);
            if (!cookie) return false;
            let selected = this.state.projects.find(p => p.id === projectId);
            if (!selected) {
                const list = await deadline(this.live.link.projects(BASE, cookie, { strict: true }), 'Loading Overleaf projects', 20000);
                const pick = await this.vscode.window.showQuickPick(list.map(p => ({ label: p.name, id: p._id })), { title: 'Open an Overleaf project with live sync' });
                if (!pick) return false;
                selected = { id: pick.id, name: pick.label };
            }
            const existing = this.recent().find(p => p.id === selected.id && p.mode === 'live');
            if (existing) { this.busy = false; return this.reopen(existing.root); }
            const url = `${BASE}/project/${selected.id}`;
            if (!/^[a-f0-9]{24}$/i.test(selected.id)) throw Error('Overleaf returned an invalid project ID.');
            parseProjectUrl(url);
            client = this.makeClient();
            const project = await deadline(client.connect(BASE, selected.id, cookie), 'Opening Overleaf project', 25000);
            const main = project.docs.find(d => d.id === project.mainId)?.path;
            const file = await this._chooseFile(project.docs.map(d => safeRemotePath(d.path)), project.name, main);
            if (!file) return false;
            root = await this._folder(project.name);
            if (!root) return false;
            const all = [...project.docs, ...client.files.values()];
            const names = new Set();
            for (const item of all) {
                const name = safeRemotePath(item.path), key = process.platform === 'linux' ? name : name.toLowerCase();
                if (names.has(key)) throw Error('This project has duplicate file paths which cannot be stored locally.');
                names.add(key);
            }
            await this._progress(`Opening “${project.name}” from Overleaf`, async progress => {
                for (const doc of project.docs) {
                    progress.report({ message: doc.path });
                    const joined = await deadline(client.join(doc.id, doc.path), 'Reading project file');
                    const target = path.join(root, ...safeRemotePath(doc.path).split('/'));
                    await fs.promises.mkdir(path.dirname(target), { recursive: true });
                    await fs.promises.writeFile(target, joined.ot.text, { flag: 'wx' });
                }
                for (const item of client.files.values()) {
                    progress.report({ message: item.path });
                    const response = await this.fetch(`${BASE}/Project/${selected.id}/file/${encodeURIComponent(item.id)}`, {
                        headers: { Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(60000) });
                    if (!response.ok) throw Error(`Could not download ${item.path} (Overleaf ${response.status}).`);
                    const target = path.join(root, ...safeRemotePath(item.path).split('/'));
                    await fs.promises.mkdir(path.dirname(target), { recursive: true });
                    await fs.promises.writeFile(target, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
                }
            });
            imported = true;
            client.close(); client = null;
            const mainSource = main || await mainFile(root, await texFiles(root)) || file;
            await this.context.globalState.update(LINKS_KEY, { ...this.live.link.links(), [root]: { url, projectName: project.name, main: mainSource, opened: [file], prefix: '' } });
            const entry = { root, name: project.name, id: selected.id, mode: 'live', file, main: mainSource, url };
            await this._remember(entry);
            this.live.tried.add(root);
            if (!(await this._show(entry, file))) return true;
            // The existing link checks differences and never silently overwrites
            // collaborators' changes made during the initial snapshot.
            if (!(await this.live.link.connect(root))) this.vscode.window.showWarningMessage('The local project is open, but live sync is not connected. Use Overleaf → Sync settings to reconnect.');
            this.live.refresh();
            return true;
        } catch (error) { this.vscode.window.showErrorMessage(`Open from Overleaf: ${error.message}`); return false; }
        finally {
            client?.close();
            if (root && !imported) await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
            this.busy = false;
        }
    }

    async openGit() {
        if (this.busy) return false;
        this.busy = true;
        let root, imported = false;
        try {
            const input = await this.vscode.window.showInputBox({ title: 'Open an Overleaf project with Git',
                prompt: 'Paste the project address or clone URL from Overleaf → Integrations → Git. Git access must be enabled for this project.',
                ignoreFocusOut: true, validateInput: value => parseOverleafConnection(value).error || null });
            if (!input) return false;
            const parsed = parseOverleafConnection(input);
            if (parsed.error) throw Error(parsed.error);
            if (new URL(parsed.url).protocol !== 'https:') throw Error('Use an https:// Overleaf Git URL.');
            const token = parsed.token || await this.vscode.window.showInputBox({ title: 'Overleaf Git token', prompt: 'Create a token in Overleaf Account settings → Git integration. Stored securely in VS Code.', password: true, ignoreFocusOut: true });
            if (!token?.trim()) return false;
            const id = new URL(parsed.url).pathname.split('/').filter(Boolean).pop();
            root = await this._folder(`Overleaf-${id}`);
            if (!root) return false;
            const result = await this._progress('Cloning Overleaf project', () => this.git._run(path.dirname(root), ['clone', '--origin', 'overleaf', '--', parsed.url, root], {
                env: { GIT_ASKPASS: this.git._askpassPath(), GIT_ASKPASS_REQUIRE: 'force', WOLFBOOK_GIT_USERNAME: 'git', WOLFBOOK_GIT_TOKEN: token.trim() } }));
            if (result.code !== 0) throw Error('Git could not open this project. Check the project URL, token and Overleaf Git access.');
            imported = true;
            await this.context.secrets.store(this.git._secretKey(root, 'overleaf'), token.trim());
            const branch = await this.git._run(root, ['branch', '--show-current']);
            if (branch.stdout.trim()) await this.git._run(root, ['config', '--local', 'wolfbook.overleafBranch', branch.stdout.trim()]);
            await this.git._run(root, ['config', '--local', 'wolfbook.overleafRemote', 'overleaf']);
            const sources = await texFiles(root), main = await mainFile(root, sources);
            const file = await this._chooseFile(sources, path.basename(root), main);
            const entry = { root, name: path.basename(root), mode: 'git', file, main, url: parsed.url };
            await this._remember(entry);
            if (!file) return false;
            await this._show(entry, file);
            return true;
        } catch (error) { this.vscode.window.showErrorMessage(`Open from Overleaf: ${error.message}`); return false; }
        finally {
            if (root && !imported) await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
            this.busy = false;
        }
    }

    async resume() {
        const pending = this.context.globalState?.get(PENDING_KEY);
        if (!pending || !this.vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === pending.root)) return;
        await this.context.globalState.update(PENDING_KEY, undefined);
        if (pending.mode === 'live') this.live.tried.add(pending.root);
        try {
            await this._show(pending, pending.file);
            if (pending.mode === 'live') await this.live.link.connect(pending.root);
            this.live.refresh();
        } catch (error) { this.vscode.window.showErrorMessage(`The local Overleaf project is ready. Could not open WPaper: ${error.message}`); }
    }

    async reopen(root) {
        const entry = this.recent().find(p => p.root === root);
        if (!entry || this.busy) return false;
        this.busy = true;
        try {
            const file = await this._chooseFile(await texFiles(root), entry.name, entry.file);
            if (!file) return false;
            let reconnect = false;
            if (entry.mode === 'live') {
                this.live.tried.add(root);
                const links = this.live.link.links(), linked = links[root];
                if (linked && !(linked.opened || []).includes(file)) {
                    await this.context.globalState.update(LINKS_KEY, { ...links, [root]: { ...linked, opened: [...(linked.opened || []), file] } });
                    reconnect = true;
                }
            }
            if (!(await this._show(entry, file))) return true;
            if (entry.mode === 'live' && await this.live.link.cookie(BASE, { ask: false }) && (reconnect || this.live.link.root !== root || !this.live.link.client)) await this.live.link.connect(root);
            this.live.refresh();
            return true;
        } catch (error) { this.vscode.window.showErrorMessage(`Open from Overleaf: ${error.message}`); return false; }
        finally { this.busy = false; }
    }

}

module.exports = { OverleafConnector, safeRemotePath, texFiles, RECENT_KEY, PENDING_KEY };
