'use strict';

// A PAPER LINKED TO AN OVERLEAF PROJECT, EDITED IN REAL TIME, IN PLACE.
//
// `wolfbook.tex.overleafSync: "live"` (off by default, not supported by
// Overleaf; its risks are accepted first, overleafLive.js). The folder of the
// paper's main file is linked to one Overleaf project, and to a folder in it —
// its top, or the one that holds the paper (the reader chooses; each is shown
// with how many of its files are already here). Files then correspond by path
// below both: with `paper/` here linked to the project's `paper/`,
// `paper/fig/a.png` here is `paper/fig/a.png` there, and a file made here is
// made in that folder there. No other window and no copy of the project: the
// editors the reader already has open are the ones kept in step. Markdown
// files and anything whose name (or folder's) starts with a dot are never
// synced.
//
// WPaper connects the way Overleaf's web editor does (tex/overleafClient.js),
// signed in with the reader's session cookie, kept in Secret Storage:
// - what the reader types goes to Overleaf as it is typed (as operations:
//   the inserted or deleted text at its place, not the file);
// - what collaborators type arrives in the open editor, as an edit (undoable,
//   caret kept), or in the file on disk when it is not open;
// - the pictures, bibliographies and styles the paper uses are fetched and
//   sent as whole files;
// - files are saved a moment after they change, as Overleaf keeps nothing
//   unsaved.
// After a dropped connection, connect again (differences are then offered
// for resolution, as at first).

const fs = require('fs');
const path = require('path');
const { OverleafLiveClient, parseProjectUrl, cookieHeader } = require('./overleafClient');
const { apply, transformX } = require('./overleafOt');
const { prepareArxiv } = require('./arxivPack');
const crypto = require('crypto');

/** Git's blob hash, the one Overleaf gives its files. */
const blobHash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const TEXT_FILE = /\.(tex|bib|sty|cls|bst|bbx|cbx|txt|md|dat|csv|tikz|pgf)$/i;

/** Never synced: Markdown notes, and anything whose name or folder starts with a dot. */
const excluded = p => /\.md$/i.test(p) || String(p).split('/').some(seg => seg.startsWith('.'));

const LINKS_KEY = 'wolfbook.tex.overleafLinks';
const cookieKey = base => `wolfbook.tex.overleafCookie:${base}`;
const SAVE_DELAY_MS = 1500;

/** What an editor change event did, as one op on the text before it. */
function changeOp(before, changes) {
    const op = [];
    for (const c of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
        if (c.rangeLength > 0) op.push({ p: c.rangeOffset, d: before.slice(c.rangeOffset, c.rangeOffset + c.rangeLength) });
        if (c.text) op.push({ p: c.rangeOffset, i: c.text });
    }
    return op;
}

/** One replacement from `before` to `after`: the span between their common ends. */
function span(before, after) {
    let a = 0;
    while (a < before.length && a < after.length && before[a] === after[a]) a++;
    let b = 0;
    while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    return { from: a, to: before.length - b, text: after.slice(a, after.length - b) };
}

class OverleafLink {
    /**
     * @param {object} o
     * @param {object} o.vscode
     * @param {object} o.context
     * @param {(line: string) => void} [o.log]
     * @param {{fetch: Function, WebSocket: Function}} [o.deps]  the transport (tests)
     */
    constructor({ vscode, context, log = () => {}, deps = null }) {
        this.vscode = vscode;
        this.context = context;
        this.log = log;
        this.deps = deps || { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
        this.client = null;
        this.root = null;
        this.state = { status: 'off' };
        this.mirrors = new Map();    // project path -> the text as this side last saw it
        this.unapplied = new Map();  // project path -> remote ops the client has, not yet in the editor
        this.echo = new Map();       // project path -> the text our own edit will produce
        this.pumping = new Set();
        this.saves = new Map();
        this.onState = () => {};
        this.subs = [];
    }

    links() { return this.context.globalState?.get(LINKS_KEY) || {}; }

    /** The link of the folder holding `file` (or of a folder above it). */
    linkFor(file) {
        if (!file) return null;
        const links = this.links();
        let dir = path.dirname(path.resolve(file));
        for (let i = 0; i < 40; i++) {
            if (links[dir]) return { root: dir, ...links[dir] };
            const up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        return null;
    }

    async cookie(base, { ask = true } = {}) {
        const stored = await this.context.secrets?.get(cookieKey(base));
        if (stored || !ask) return stored || null;
        return this.askCookie(base);
    }

    async askCookie(base) {
        const v = await this.vscode.window.showInputBox({
            title: `Overleaf session cookie for ${new URL(base).host}`,
            prompt: `In the browser, signed in to ${new URL(base).host}: developer tools (⌥⌘I) → Application → Storage → Cookies → ${base} → overleaf_session2 → copy its Value. It is kept in VS Code Secret Storage; it gives access to your Overleaf account.`,
            placeHolder: 's%3A…',
            password: true, ignoreFocusOut: true,
        });
        if (!v || !v.trim()) return null;
        let header;
        try { header = cookieHeader(v); } catch (e) { this.vscode.window.showErrorMessage(e.message); return null; }
        await this.context.secrets?.store(cookieKey(base), header);
        return header;
    }

    /** Your Overleaf projects, newest first ([] when they cannot be read). */
    async projects(base, cookie) {
        try {
            const r = await this.deps.fetch(`${base}/user/projects`, { headers: { Cookie: cookie, Accept: 'application/json' }, redirect: 'manual' });
            if (!r.ok) return [];
            const j = await r.json();
            return (j.projects || []).filter(p => p && p._id && p.accessLevel !== 'readOnly');
        } catch (_) { return []; }
    }

    /** The project's text files, by path (`/project/:id/entities`); null when they cannot be read. */
    async projectFiles(base, projectId, cookie) {
        try {
            const r = await this.deps.fetch(`${base}/project/${projectId}/entities`, { headers: { Cookie: cookie, Accept: 'application/json' }, redirect: 'manual' });
            if (!r.ok) return null;
            const j = await r.json();
            return (j.entities || []).filter(e => e && e.path).map(e => String(e.path).replace(/^\/+/, '')).filter(p => !excluded(p));
        } catch (_) { return null; }
    }

    /**
     * The project's folders that could be the paper's folder here: its top
     * and every folder in it, each scored by how many of the files below it
     * are here at the same path. Best first; at a tie the shallower.
     */
    overleafFolders(root, paths) {
        const dirs = new Set(['']);
        for (const p of paths || []) {
            const parts = p.split('/');
            for (let k = 1; k < parts.length; k++) dirs.add(`${parts.slice(0, k).join('/')}/`);
        }
        return [...dirs].map(dir => {
            const below = (paths || []).filter(p => p.startsWith(dir));
            const found = below.filter(p => fs.existsSync(path.join(root, ...p.slice(dir.length).split('/')))).length;
            return { dir, found, total: below.length };
        }).sort((x, y) => y.found - x.found || x.dir.length - y.dir.length);
    }

    /**
     * Link a folder to an Overleaf project and connect: the project chosen
     * from the reader's list (or pasted), the folder that corresponds to
     * the project's top chosen next (the main file's by default), and the
     * link confirmed before anything is changed.
     */
    async link(file, { base = 'https://www.overleaf.com' } = {}) {
        const w = this.vscode.window;
        const cookie = await this.cookie(base);
        if (!cookie) return false;
        const list = await this.projects(base, cookie);
        const paste = { label: '$(link) Paste a project address…', paste: true };
        const items = [...list.map(p => ({ label: p.name, description: p.accessLevel, id: p._id })), paste];
        const pick = await w.showQuickPick(items, {
            title: 'Link this paper to an Overleaf project',
            placeHolder: list.length ? 'Your Overleaf projects' : 'Your project list could not be read — paste the project\'s address',
        });
        if (!pick) return false;
        let url, name = pick.label;
        if (pick.paste) {
            const v = await w.showInputBox({ title: 'Overleaf project address', placeHolder: `${base}/project/…`, ignoreFocusOut: true,
                validateInput: s => { try { parseProjectUrl(s); return null; } catch (e) { return e.message; } } });
            if (!v) return false;
            url = v.trim();
            name = null;
        } else url = `${base}/project/${pick.id}`;
        const { projectId } = parseProjectUrl(url);
        const paths = await this.projectFiles(base, projectId, cookie);

        // WHICH FOLDER OF THE PROJECT IS THIS PAPER'S FOLDER. Its top, or a
        // folder in it — with how many of its files are already here.
        const root = path.dirname(path.resolve(file));
        const shown = p => this.vscode.workspace.asRelativePath ? this.vscode.workspace.asRelativePath(p, true) : p;
        const here = shown(root);
        const folderItems = this.overleafFolders(root, paths).map((c, k) => ({
            label: c.dir ? `$(folder) ${c.dir}` : '$(root-folder) the project\'s top',
            description: paths ? `${c.found} of its ${c.total} files are in ${here}${k === 0 && c.found ? ' — best match' : ''}` : '',
            dir: c.dir,
        }));
        folderItems.push({ label: '$(new-folder) A new folder in the project…', fresh: true });
        const where = await w.showQuickPick(folderItems, {
            title: `Which folder of “${name || 'the project'}” is ${here}?`,
            placeHolder: `${here}/main.tex corresponds to <that folder>/main.tex on Overleaf; files made here are made there`,
        });
        if (!where) return false;
        let prefix = where.dir || '';
        if (where.fresh) {
            const v = await w.showInputBox({ title: 'New folder in the Overleaf project', value: path.basename(root), ignoreFocusOut: true,
                validateInput: s => (/^[^/\\.][^/\\]*(\/[^/\\.][^/\\]*)*$/.test(s.trim().replace(/\/$/, '')) ? null : 'A folder name (folders separated by /), not starting with a dot') });
            if (!v) return false;
            prefix = `${v.trim().replace(/\/$/, '')}/`;
        }

        // CONFIRMED BEFORE ANYTHING CHANGES.
        const under = (paths || []).filter(p => p.startsWith(prefix));
        const found = under.filter(p => fs.existsSync(path.join(root, ...p.slice(prefix.length).split('/'))));
        const only = under.filter(p => !found.includes(p));
        const pairs = (found.length ? found : under).slice(0, 4)
            .map(p => `${shown(path.join(root, ...p.slice(prefix.length).split('/')))}  ↔  ${p}`);
        const mainHere = path.relative(root, path.resolve(file)).split(path.sep).join('/');
        if (!pairs.length) pairs.push(`${shown(path.resolve(file))}  ↔  ${prefix}${mainHere}`);
        const go = 'Link and connect';
        const ok = await w.showWarningMessage(
            `Link “${here}” to ${prefix ? `the folder “${prefix}” of` : 'the top of'} the Overleaf project “${name || url}”?`,
            { modal: true, detail: [
                'Files correspond by path:', ...pairs, '',
                paths ? `${found.length} of the ${under.length} files there are in ${here}` +
                    (only.length ? `; ${only.length} only on Overleaf will be written into it.` : '.') : '',
                `Files the paper uses that Overleaf lacks are made in ${prefix ? `“${prefix}”` : 'the project\'s top'}.`,
                'Markdown files and files whose name starts with a dot are not synced.',
                'Files that differ are listed for you to choose which version to keep before anything is changed.',
            ].join('\n') },
            go);
        if (ok !== go) return false;
        const links = { ...this.links(), [root]: { url, projectName: name, main: mainHere, prefix } };
        await this.context.globalState?.update(LINKS_KEY, links);
        const connected = await this.connect(root);
        if (connected) {
            w.showInformationMessage(`Linked “${here}” to ${prefix ? `“${prefix}” in` : 'the top of'} the Overleaf project “${this.state.project}”: ${this.state.detail}. What you type now appears in Overleaf.`);
        }
        return connected;
    }

    async unlink(root) {
        if (this.root === root) this.disconnect();
        const links = { ...this.links() };
        delete links[root];
        await this.context.globalState?.update(LINKS_KEY, links);
        this.setState({ status: 'off' });
    }

    setState(s) {
        this.state = s;
        try { this.onState(s); } catch (_) { /* the status item is a courtesy */ }
    }

    get connected() { return !!this.client && this.state.status === 'connected'; }

    /** A project path this link syncs: below its folder there, and not excluded. */
    inside(p) { return typeof p === 'string' && p.startsWith(this.prefix || '') && !excluded(p); }
    /** The project path of a local file (null outside the linked folder, or excluded). */
    rel(fsPath) {
        if (!this.root || !fsPath) return null;
        const r = path.relative(this.root, fsPath);
        if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
        const p = `${this.prefix || ''}${r.split(path.sep).join('/')}`;
        return excluded(p) ? null : p;
    }
    /** Where a project path is here. */
    abs(p) { return path.join(this.root, ...p.slice((this.prefix || '').length).split('/')); }

    /** The project path of a local file, when it is in the linked folder and synced. */
    projectPath(fsPath) {
        const p = this.rel(fsPath);
        return p && this.client?.byPath(p) ? p : null;
    }

    openDoc(p) {
        const target = this.abs(p);
        return (this.vscode.workspace.textDocuments || []).find(d => d.uri && d.uri.fsPath === target && !d.isClosed) || null;
    }

    localText(p) {
        const d = this.openDoc(p);
        if (d) return d.getText();
        try { return fs.readFileSync(this.abs(p), 'utf8'); } catch (_) { return null; }
    }

    async connect(root) {
        const link = this.links()[root];
        if (!link) return false;
        this.disconnect();
        let base, projectId;
        try { ({ base, projectId } = parseProjectUrl(link.url)); }
        catch (e) { this.setState({ status: 'error', detail: e.message }); return false; }
        const cookie = await this.cookie(base);
        if (!cookie) { this.setState({ status: 'error', detail: 'No Overleaf session cookie' }); return false; }
        const client = new OverleafLiveClient({
            remote: (p, op) => {
                const list = this.unapplied.get(p) || [];
                list.push(op);
                this.unapplied.set(p, list);
                this.pump(p).catch(e => this.log(`overleaf live: ${e.message}`));
            },
            tree: message => this.vscode.window.showInformationMessage(`Overleaf: ${message}`),
            fileChanged: (p, id) => { this.fileChanged(p, id).catch(e => this.log(`overleaf live: ${e.message}`)); },
            docAdded: (id, p) => { this.docAdded(id, p).catch(e => this.log(`overleaf live: ${e.message}`)); },
            closed: reason => {
                if (this.client !== client) return;
                this.client = null;
                this.setState({ status: 'error', project: this.state.project, detail: `Disconnected (${reason}). Connect again to go on.` });
            },
        }, this.deps);
        this.client = client;
        this.root = root;
        this.prefix = link.prefix || '';
        this.setState({ status: 'connecting', detail: 'Connecting to Overleaf…' });
        try {
            const project = await client.connect(base, projectId, cookie);
            // Only this link's folder of the project, never what is excluded,
            // and of that only what the paper uses: its main file and what the
            // main file names (and they name), here or on Overleaf.
            project.docs = project.docs.filter(d => this.inside(d.path));
            for (const [id, f] of [...client.files]) if (!this.inside(f.path)) client.files.delete(id);
            this.base = base; this.projectId = projectId; this.cookieHeader = cookie; this.main = link.main || null;
            this.projectDocs = new Map(project.docs.map(d => [d.path, d.id]));
            const uses = await this.resolveDependencies();
            const differ = [];
            for (const p of uses) {
                const doc = client.byPath(p);
                if (!doc) continue;
                const mine = this.localText(p);
                if (mine !== doc.ot.text) differ.push({ path: p, local: mine, server: doc.ot.text });
                this.mirrors.set(p, mine === null ? doc.ot.text : mine);
            }
            // The pictures and other files the paper uses: fetched when missing
            // here, compared when both have them; what Overleaf lacks is sent.
            const binaries = [], missing = [];
            for (const f of client.files.values()) {
                if (!uses.has(f.path)) continue;
                const local = this.readLocal(f.path);
                if (!local) { missing.push(f); continue; }
                if (f.hash && blobHash(local) === f.hash) continue;
                const remote = await this.download(f.id);
                if (!remote.equals(local)) binaries.push({ path: f.path, remote });
            }
            const upload = [...uses].filter(p => !this.projectDocs.has(p) && !client.fileByPath(p) && this.readLocal(p));
            const changed = [...differ.filter(d => d.local !== null), ...binaries];
            let pick = 'overleaf';
            if (changed.length) {
                const theirs = 'Use Overleaf\'s version', mine = 'Send mine to Overleaf';
                const answer = await this.vscode.window.showWarningMessage(
                    `${changed.length} file${changed.length === 1 ? '' : 's'} of ${path.basename(root)} differ${changed.length === 1 ? 's' : ''} from Overleaf's “${project.name}”`,
                    { modal: true, detail: `${changed.map(d => d.path).slice(0, 12).join('\n')}${changed.length > 12 ? '\n…' : ''}\n\n` +
                        'Use Overleaf\'s version: your text of these files is replaced (the editor can undo it).\n' +
                        'Send mine to Overleaf: Overleaf\'s text of these files is replaced, for every collaborator.' },
                    theirs, mine);
                if (!answer) { this.disconnect(); return false; }
                pick = answer === mine ? 'mine' : 'overleaf';
            }
            for (const d of differ) {
                if (d.local === null || pick === 'overleaf') await this.replaceLocal(d.path, d.server);
                else client.local(d.path, [...(d.server ? [{ p: 0, d: d.server }] : []), ...(d.local ? [{ p: 0, i: d.local }] : [])]);
            }
            for (const b of binaries) {
                if (pick === 'overleaf') this.writeLocal(b.path, b.remote);
                else await this.upload(b.path, this.readLocal(b.path));
            }
            for (const f of missing) this.writeLocal(f.path, await this.download(f.id));
            for (const p of upload) await this.upload(p, this.readLocal(p));
            // Overleaf's text taken here can name files the old text did not.
            if (pick === 'overleaf' && differ.some(d => d.local !== null)) await this.newDependencies();
            const texts = [...uses].filter(p => client.byPath(p) || (TEXT_FILE.test(p) && upload.includes(p))).length;
            const others = uses.size - texts;
            this.filesNote = others ? ` and ${others} other file${others === 1 ? '' : 's'}` : '';
            if (upload.length) this.filesNote += ` (${upload.length} sent from here)`;
            this.texts = texts;
            if (!link.projectName) {
                await this.context.globalState?.update(LINKS_KEY, { ...this.links(), [root]: { ...link, projectName: project.name } });
            }
            this.watch();
            this.setState({ status: 'connected', project: project.name,
                detail: `${texts} document${texts === 1 ? '' : 's'}${this.filesNote} the paper uses in step with Overleaf` });
            // Edits made while connecting (an agent's write, a keystroke) had
            // no listener yet: whatever differs now is sent.
            this.checkInStep('edited while connecting');
            return true;
        } catch (e) {
            if (this.client === client) { client.close(); this.client = null; }
            // A refused session: the cookie is forgotten, so the next connect asks for a fresh one.
            const refused = /session cookie|HTTP 40[13]/.test(e.message);
            if (refused) await this.context.secrets?.delete?.(cookieKey(base));
            this.setState({ status: 'error', detail: refused
                ? 'Overleaf did not accept the session cookie (signed out, or expired) — set it again' : e.message });
            return false;
        }
    }

    disconnect() {
        const c = this.client;
        this.client = null;
        c?.close();
        for (const s of this.subs) { try { s.dispose(); } catch (_) {} }
        this.subs = [];
        this.mirrors.clear(); this.unapplied.clear(); this.echo.clear();
        this._csrf = null; this.sent = null; this.written = null; this.uses = null; this.projectDocs = null; this.warnedDrift = false;
        clearTimeout(this.depsTimer);
        clearTimeout(this.positionTimer); this.positionTimer = null; this.position = null;
        for (const t of (this.pending || new Map()).values()) clearTimeout(t);
        this.pending = null;
        for (const t of this.saves.values()) clearTimeout(t);
        this.saves.clear();
        if (this.state.status !== 'off') this.setState({ status: 'off' });
    }

    /** Local edits of synced documents go to Overleaf. */
    watch() {
        this.subs.push(this.vscode.workspace.onDidChangeTextDocument(e => this.changed(e)));
        // PRESENCE: where the caret is, as Overleaf's editor reports it, so
        // you appear in the project with your cursor in the file you edit.
        // Re-sent every minute: Overleaf lets a silent client's presence lapse.
        const sel = this.vscode.window.onDidChangeTextEditorSelection?.(e => this.caretMoved(e.textEditor));
        if (sel) this.subs.push(sel);
        const act = this.vscode.window.onDidChangeActiveTextEditor?.(ed => { if (ed) this.caretMoved(ed); });
        if (act) this.subs.push(act);
        const check = setInterval(() => this.checkInStep('periodic check'), 15000);
        check.unref?.();
        this.subs.push({ dispose: () => clearInterval(check) });
        const keep = setInterval(() => this.sendPosition(), 60000);
        keep.unref?.();
        this.subs.push({ dispose: () => clearInterval(keep) });
        const ed = this.vscode.window.activeTextEditor;
        if (ed) this.caretMoved(ed);
        // The files the paper uses, changed on disk here: sent to Overleaf.
        const w = this.vscode.workspace.createFileSystemWatcher?.(new this.vscode.RelativePattern(this.root, '**/*'));
        if (w) {
            const on = uri => this.localFileChanged(uri.fsPath);
            this.subs.push(w, w.onDidCreate(on), w.onDidChange(on));
        }
    }

    /** The caret moved in an editor: its place is sent (at most every 300 ms) when it is a synced document. */
    caretMoved(editor) {
        const p = this.projectPath(editor?.document?.uri?.fsPath);
        const doc = p && this.client?.byPath(p);
        if (!doc || !editor.selection) return;
        const at = editor.selection.active;
        this.position = { row: at.line, column: at.character, doc_id: doc.id };
        if (this.positionTimer) return;
        this.positionTimer = setTimeout(() => { this.positionTimer = null; this.sendPosition(); }, 300);
    }

    sendPosition() {
        if (!this.position || !this.connected || !this.client?.socket) return;
        this.client.socket.emit('clientTracking.updatePosition', [this.position]).catch(() => {});
    }

    // --- the files the paper uses (pictures, bibliographies, styles) ----------

    readLocal(p) { try { return fs.readFileSync(this.abs(p)); } catch (_) { return null; } }
    writeLocal(p, bytes) {
        fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
        (this.written ||= new Map()).set(p, blobHash(bytes));
        fs.writeFileSync(this.abs(p), bytes);
    }

    /**
     * What the paper uses, from its main file: its sources, pictures (with
     * \\graphicspath and the extensions graphicx tries), local styles and
     * data files — WPaper's arXiv collector — and its bibliographies. A file
     * counts whether it is here or only on Overleaf (a source only there is
     * read from there, once joined). As project paths, never excluded ones.
     */
    dependencies() {
        const pre = this.prefix || '';
        const local = r => path.join(this.root, ...r.split('/'));
        const remoteDoc = r => this.client?.byPath(pre + r);
        const remoteHas = r => this.projectDocs?.has(pre + r) || !!this.client?.fileByPath(pre + r);
        const exists = r => fs.existsSync(local(r)) || remoteHas(r);
        // The main file the link was made from; for an older link, the
        // project's main.tex, else its document that has \\documentclass.
        const docsHere = [...(this.projectDocs?.keys() || [])].map(p => p.slice(pre.length)).filter(p => /\.tex$/i.test(p));
        const main = this.main && exists(this.main) ? this.main
            : (docsHere.find(p => /(^|\/)main\.tex$/.test(p)) ||
               docsHere.find(p => { try { return /\\documentclass/.test(fs.readFileSync(local(p), 'utf8')); } catch (_) { return false; } }) || null);
        if (!main) return new Set();
        this.mainRel = main;
        const readBinary = r => { try { return fs.readFileSync(local(r)); } catch (_) { return remoteHas(r) ? Buffer.alloc(0) : null; } };
        // The editor's text first (it may be unsaved), then the file, then Overleaf's.
        const read = r => {
            const open = this.openDoc(pre + r);
            if (open) return open.getText();
            // A source only Overleaf has, not joined yet, counts (as empty): the
            // next round has joined it and reads what it names.
            try { return fs.readFileSync(local(r), 'utf8'); } catch (_) { return remoteDoc(r)?.ot.text ?? (remoteHas(r) ? '' : null); }
        };
        let report;
        try {
            report = prepareArxiv({ main, read, readBinary, exists, options: { comments: false, draft: false } }).report;
        } catch (_) { report = { tex: [main], figures: [], other: [] }; }
        const out = new Set([main, ...report.tex, ...report.figures, ...report.other]);
        const mainDir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
        for (const t of report.tex) {
            const text = read(t) || '';
            for (const m of text.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
                for (const name of m[1].split(',').map(x => x.trim()).filter(Boolean)) {
                    const bib = /\.bib$/i.test(name) ? name : `${name}.bib`;
                    const found = [bib, mainDir + bib].find(r => exists(r));
                    if (found) out.add(found);
                }
            }
        }
        return new Set([...out].map(r => pre + r).filter(p => !excluded(p)));
    }

    /**
     * The paper's files, with every source among them that is on Overleaf
     * joined (so that what only Overleaf has is read too, and followed).
     */
    async resolveDependencies() {
        const pre = this.prefix || '';
        const mainPath = this.main ? pre + this.main : null;
        if (mainPath && this.projectDocs.has(mainPath) && !this.client.byPath(mainPath)) await this.client.join(this.projectDocs.get(mainPath), mainPath);
        let uses = new Set();
        for (let round = 0; round < 6; round++) {
            uses = this.dependencies();
            let joined = false;
            for (const p of uses) {
                if (this.projectDocs.has(p) && !this.client.byPath(p)) { await this.client.join(this.projectDocs.get(p), p); joined = true; }
            }
            if (!joined) break;
        }
        this.uses = uses;
        return uses;
    }

    /**
     * The paper was edited: what it uses now. A source or picture it has
     * just started to use is brought into step (fetched, joined, or sent).
     */
    refreshDependencies() {
        clearTimeout(this.depsTimer);
        this.depsTimer = setTimeout(() => { if (this.connected) this.newDependencies().catch(() => {}); }, 1500);
    }

    async newDependencies() {
        {
            const before = this.uses || new Set();
            const uses = await this.resolveDependencies().catch(() => before);
            for (const p of uses) {
                if (before.has(p)) continue;
                try {
                    const doc = this.client.byPath(p);
                    if (doc) {
                        const mine = this.localText(p);
                        if (mine === null) { this.writeLocal(p, Buffer.from(doc.ot.text, 'utf8')); this.mirrors.set(p, doc.ot.text); }
                        else {
                            this.mirrors.set(p, mine);
                            if (mine !== doc.ot.text) this.vscode.window.showWarningMessage(`Overleaf: ${p}, which the paper now uses, differs from Overleaf's — connect again to choose which to keep.`);
                        }
                        continue;
                    }
                    const f = this.client.fileByPath(p);
                    const local = this.readLocal(p);
                    if (f && !local) this.writeLocal(p, await this.download(f.id));
                    else if (!f && local) await this.upload(p, local);
                    else if (f && local && f.hash !== blobHash(local)) {
                        this.vscode.window.showWarningMessage(`Overleaf: ${p}, which the paper now uses, differs from Overleaf's — connect again to choose which to keep.`);
                    }
                } catch (e) { this.log(`overleaf live: ${p}: ${e.message}`); }
            }
        }
    }

    async http(pathname, init = {}) {
        const r = await this.deps.fetch(`${this.base}${pathname}`, { ...init, redirect: 'manual',
            headers: { Cookie: this.cookieHeader, ...(init.headers || {}) } });
        if (!r.ok) throw Error(`Overleaf answered ${r.status} for ${pathname.replace(/\?.*$/, '')}`);
        return r;
    }

    async download(fileId) {
        const r = await this.http(`/Project/${this.projectId}/file/${fileId}`);
        return Buffer.from(await r.arrayBuffer());
    }

    /** The editor page's CSRF token, which Overleaf wants on every change made over HTTP. */
    async csrf() {
        if (this._csrf) return this._csrf;
        const html = await (await this.http(`/project/${this.projectId}`)).text();
        const m = /<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/.exec(html);
        if (!m) throw Error('Overleaf\'s page gave no CSRF token');
        return (this._csrf = m[1]);
    }

    async ensureFolder(dir) {
        const known = this.client.folderId(dir);
        if (known) return known;
        const parts = dir.replace(/\/$/, '').split('/');
        const parent = await this.ensureFolder(parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '');
        const r = await this.http(`/project/${this.projectId}/folder`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': await this.csrf() },
            body: JSON.stringify({ name: parts.at(-1), parent_folder_id: parent }) });
        const folder = await r.json();
        this.client.folders.set(folder._id, dir);
        return folder._id;
    }

    /** A file the paper uses, sent to Overleaf (a new one is created; one of that name is replaced). */
    async upload(p, bytes) {
        if (!bytes) return;
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
        const name = p.slice(dir.length);
        const folderId = await this.ensureFolder(dir);
        const form = new FormData();
        form.append('name', name);
        form.append('qqfile', new Blob([bytes]), name);
        (this.sent ||= new Map()).set(p, blobHash(bytes));
        const r = await this.http(`/Project/${this.projectId}/upload?folder_id=${folderId}`, { method: 'POST',
            headers: { 'X-Csrf-Token': await this.csrf() }, body: form });
        const j = await r.json().catch(() => ({}));
        if (j.success === false) throw Error(`Overleaf refused ${p}: ${j.error || 'upload failed'}`);
    }

    /** A collaborator uploaded or replaced a file: fetched, unless it is what we just sent. */
    async fileChanged(p, id) {
        if (!this.inside(p)) { this.client?.files.delete(id); return; }
        if (!this.uses?.has(p)) return;                     // not a file the paper uses
        const bytes = await this.download(id);
        const h = blobHash(bytes);
        if (this.sent?.get(p) === h) { this.sent.delete(p); return; }
        const local = this.readLocal(p);
        if (local && blobHash(local) === h) return;
        this.writeLocal(p, bytes);
    }

    /** A document added on Overleaf (by a collaborator, or our upload): joined and kept in step. */
    async docAdded(id, p) {
        if (!this.client || this.client.byPath(p) || !this.inside(p)) return;
        this.projectDocs?.set(p, id);
        // Joined when the paper uses it (our own upload of one it uses, or a
        // collaborator's file the paper names); otherwise only noted.
        if (!this.uses?.has(p) && !this.sent?.has(p)) { this.refreshDependencies(); return; }
        const doc = await this.client.join(id, p);
        const mine = this.localText(p);
        if (mine === null) { this.writeLocal(p, Buffer.from(doc.ot.text, 'utf8')); this.mirrors.set(p, doc.ot.text); return; }
        this.mirrors.set(p, mine);
        if (mine !== doc.ot.text) {
            if (this.sent?.has(p)) { this.sent.delete(p); await this.replaceLocal(p, doc.ot.text); }
            else this.vscode.window.showWarningMessage(`Overleaf: ${p} was added on Overleaf with other text than yours; yours is kept here — connect again to choose.`);
        }
    }

    /** A file under the linked folder changed on disk: sent on when the paper uses it (and it is not a synced document). */
    localFileChanged(fsPath) {
        const p = this.rel(fsPath);
        if (!p || !this.connected) return;
        if (this.client.byPath(p)) {
            // A synced document changed on disk (an agent's edit, a git pull):
            // an open editor reloads it and its change event sends it; one
            // that is not open is sent from here, as the changed span.
            if (this.openDoc(p)) return;
            clearTimeout((this.pending ||= new Map()).get(p));
            this.pending.set(p, setTimeout(() => { this.pending.delete(p); this.diskTextChanged(p); }, 300));
            return;
        }
        clearTimeout((this.pending ||= new Map()).get(p));
        this.pending.set(p, setTimeout(() => {
            this.pending.delete(p);
            const bytes = this.readLocal(p);
            if (!bytes) return;
            const h = blobHash(bytes);
            if (this.written?.get(p) === h) { this.written.delete(p); return; }   // what we wrote
            const remote = this.client?.fileByPath(p);
            if (remote && remote.hash === h) return;
            if (!this.uses?.has(p)) return;                                         // not the paper's
            this.upload(p, bytes).catch(e => this.vscode.window.showWarningMessage(`Overleaf: ${e.message}`));
        }, 600));
    }

    /** A synced document not open in any editor, changed on disk: what changed goes to Overleaf. */
    diskTextChanged(p) {
        if (!this.connected || this.openDoc(p)) return;
        let text;
        try { text = fs.readFileSync(this.abs(p), 'utf8'); } catch (_) { return; }
        const before = this.mirrors.get(p);
        if (before === undefined || text === before) return;     // ours (a collaborator's edit written here), or nothing
        const s = span(before, text);
        let op = [...(s.to > s.from ? [{ p: s.from, d: before.slice(s.from, s.to) }] : []), ...(s.text ? [{ p: s.from, i: s.text }] : [])];
        this.mirrors.set(p, text);
        const list = this.unapplied.get(p) || [];
        for (let k = 0; k < list.length; k++) [op, list[k]] = transformX(op, list[k]);
        this.client?.local(p, op);
        if (/\\(input|include|includegraphics|bibliography|addbibresource|usepackage)/.test(s.text + before.slice(s.from, s.to))) this.refreshDependencies();
    }

    changed(e) {
        const p = this.projectPath(e.document?.uri?.fsPath);
        if (!p || !e.contentChanges?.length) return;
        const text = e.document.getText();
        // Our own edit (a collaborator's, applied): already Overleaf's.
        if (this.echo.get(p) === text) { this.echo.delete(p); this.mirrors.set(p, text); return; }
        const before = this.mirrors.get(p);
        this.mirrors.set(p, text);
        if (before === undefined) return;
        let op = changeOp(before, e.contentChanges);
        const list = this.unapplied.get(p) || [];
        // NEVER AN EDIT AT THE WRONG PLACE. With nothing of a collaborator's
        // waiting, Overleaf's text (as the client holds it) must be the text
        // before this change; if it is not, what this side knew had drifted,
        // and an op computed on it would land at wrong offsets (or fail and
        // be lost). Then Overleaf is brought to the editor's text instead.
        const theirs = this.client?.byPath(p)?.ot.text;
        if (!list.length && theirs !== undefined && theirs !== before) { this.heal(p, text, 'before an edit'); this.scheduleSave(p); return; }
        try {
            // Collaborators' edits the client has and the editor has not yet:
            // ours goes past them, and they past ours.
            for (let k = 0; k < list.length; k++) [op, list[k]] = transformX(op, list[k]);
            this.client?.local(p, op);
        } catch (error) {
            this.log(`overleaf live: ${p}: ${error.message}`);
            if (!list.length) this.heal(p, text, error.message);
        }
        this.scheduleSave(p);
        // What the paper uses may have changed (\\input, \\includegraphics, \\bibliography).
        if (/\\(input|include|subfile|import|includegraphics|includepdf|graphicspath|bibliography|addbibresource|usepackage|documentclass)/.test(e.contentChanges.map(c => c.text).join('') + op.filter(c => c.d).map(c => c.d).join(''))) this.refreshDependencies();
    }

    /**
     * Bring Overleaf to `text` (the editor's), as one edit of the span where
     * they differ. Only when no collaborator's edit is waiting to reach the
     * editor: then every difference is ours, lost on the way. Said in the log,
     * and once to the reader.
     */
    heal(p, text, why) {
        const doc = this.client?.byPath(p);
        if (!doc || (this.unapplied.get(p) || []).length) return false;
        const theirs = doc.ot.text;
        if (theirs === text) { this.mirrors.set(p, text); return true; }
        const s = span(theirs, text);
        const op = [...(s.to > s.from ? [{ p: s.from, d: theirs.slice(s.from, s.to) }] : []), ...(s.text ? [{ p: s.from, i: s.text }] : [])];
        try { this.client.local(p, op); }
        catch (error) { this.log(`overleaf live: ${p}: could not resynchronise: ${error.message}`); return false; }
        this.mirrors.set(p, text);
        this.log(`overleaf live: ${p} had drifted from Overleaf (${why}); Overleaf now has the editor's text (${s.to - s.from} characters replaced by ${s.text.length})`);
        if (!this.warnedDrift) {
            this.warnedDrift = true;
            this.vscode.window.showWarningMessage(`Overleaf: ${p} had gone out of step with Overleaf; Overleaf now has your editor's text. (Details in the WPaper output.)`);
        }
        return true;
    }

    /** Every file in step, checked: what differs with nothing on its way is repaired (heal). */
    checkInStep(why) {
        if (!this.connected) return;
        for (const p of this.mirrors.keys()) {
            const doc = this.client?.byPath(p);
            if (!doc || doc.ot.inflight || doc.ot.pending.length || (this.unapplied.get(p) || []).length || this.pumping.has(p)) continue;
            const mine = this.localText(p);
            if (mine === null) continue;
            if (mine !== doc.ot.text) this.heal(p, mine, why);
        }
    }

    /** Collaborators' edits into the editor (or the file), one after another. */
    async pump(p) {
        if (this.pumping.has(p)) return;
        this.pumping.add(p);
        try {
            for (let tries = 0; (this.unapplied.get(p) || []).length && tries < 200; tries++) {
                const list = this.unapplied.get(p);
                const op = list[0];
                const before = this.mirrors.get(p) ?? '';
                let next;
                try { next = apply(before, op); }
                catch (_) {
                    // Out of step: Overleaf's text wins when nothing else waits.
                    const truth = this.client?.byPath(p)?.ot.text;
                    if (truth === undefined || list.length > 1) throw Error(`${p} went out of step with Overleaf; connect again`);
                    next = truth;
                }
                const doc = this.openDoc(p);
                if (doc) {
                    if (doc.getText() !== before) { await new Promise(r => setTimeout(r, 10)); continue; }
                    const s = span(before, next);
                    const we = new this.vscode.WorkspaceEdit();
                    we.replace(doc.uri, new this.vscode.Range(doc.positionAt(s.from), doc.positionAt(s.to)), s.text);
                    this.echo.set(p, next);
                    const ok = await this.vscode.workspace.applyEdit(we);
                    // Refused (the reader typed meanwhile): the op, transformed
                    // past that edit by `changed`, is tried again.
                    if (!ok) { this.echo.delete(p); continue; }
                    this.mirrors.set(p, next);
                } else {
                    const file = this.abs(p);
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, next);
                    this.mirrors.set(p, next);
                }
                list.shift();
                this.scheduleSave(p);
            }
        } finally { this.pumping.delete(p); }
    }

    /** At connecting: Overleaf's text for a local file, as an undoable edit when it is open. */
    async replaceLocal(p, text) {
        const doc = this.openDoc(p);
        if (doc) {
            const s = span(doc.getText(), text);
            const we = new this.vscode.WorkspaceEdit();
            we.replace(doc.uri, new this.vscode.Range(doc.positionAt(s.from), doc.positionAt(s.to)), s.text);
            await this.vscode.workspace.applyEdit(we);
            await doc.save();
        } else {
            const file = this.abs(p);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
        }
        this.mirrors.set(p, text);
    }

    scheduleSave(p) {
        clearTimeout(this.saves.get(p));
        this.saves.set(p, setTimeout(() => {
            this.saves.delete(p);
            const doc = this.connected && this.openDoc(p);
            if (doc && doc.isDirty) doc.save().then(undefined, () => {});
        }, SAVE_DELAY_MS));
    }

    dispose() { this.disconnect(); }
}

module.exports = { OverleafLink, changeOp, span, excluded, LINKS_KEY, cookieKey };
