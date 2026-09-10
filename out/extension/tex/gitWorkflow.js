'use strict';

// WPaper's write-side Git workflow. The summarising helpers are deliberately
// independent of VS Code and Git so their scientific-document semantics can be
// tested without touching a repository.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection)\*?\s*\{/g;
const EQUATION_ENVS = '(?:equation|align|alignat|gather|multline|flalign|eqnarray|displaymath)';
const OVERLEAF_GIT_DOCS = 'https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git';

/** Parse, but never execute, an Overleaf URL or pasted Git command. */
function parseOverleafConnection(value) {
    const input = String(value || '').trim();
    const hit = input.match(/https?:\/\/[^\s'"<>]+/i);
    if (!hit) return { error: 'Paste the Git URL or the git clone/pull command shown by Overleaf.' };
    let raw = hit[0].replace(/[),.;]+$/, '');
    let url;
    try { url = new URL(raw); }
    catch (_) { return { error: 'That does not contain a valid HTTPS Git URL.' }; }

    // A project browser URL is useful too: turn it into the documented Cloud
    // Git endpoint instead of making the reader go back and copy another URL.
    if (/^(?:www\.)?overleaf\.com$/i.test(url.hostname)) {
        const project = /^\/project\/([^/?#]+)/.exec(url.pathname);
        if (!project) return { error: 'Open the Overleaf project, then copy its Git command from Integrations → Git.' };
        url = new URL(`https://git@git.overleaf.com/${project[1]}`);
    }
    const cloud = /^git\.overleaf\.com$/i.test(url.hostname);
    const serverPro = url.username === 'git' && /\/git\//i.test(url.pathname);
    if (!cloud && !serverPro) {
        return { error: 'That URL does not look like an Overleaf Cloud or Overleaf Server Pro Git URL.' };
    }
    let token = '';
    try { token = decodeURIComponent(url.password || ''); } catch (_) { token = url.password || ''; }
    const named = input.match(/(?:token|password)\s*[:=]\s*([^\s'"<>]+)/i);
    if (!token && named) token = named[1];
    // Credentials must never be left in .git/config or echoed in a command.
    url.username = 'git';
    url.password = '';
    url.hash = '';
    url.search = '';
    return { url: url.toString().replace(/\/$/, ''), token, branch: 'master' };
}

function isOverleafUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return /^git\.overleaf\.com$/i.test(url.hostname) ||
            (url.username === 'git' && /\/git\//i.test(url.pathname));
    } catch (_) { return false; }
}

function lineAt(text, offset) {
    let n = 1;
    for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

function balancedArgument(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1).split('\n')[0];
}

function plainTitle(tex) {
    return String(tex || '')
        .replace(/\\texorpdfstring\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$2')
        .replace(/\\(?:label|footnote)\s*\{[^{}]*\}/g, '')
        .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, '')
        .replace(/[{}$]/g, '')
        .replace(/~/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sectionHeadings(text) {
    const src = String(text || '');
    const out = [];
    SECTION_RE.lastIndex = 0;
    let m;
    while ((m = SECTION_RE.exec(src))) {
        const open = SECTION_RE.lastIndex - 1;
        const title = plainTitle(balancedArgument(src, open));
        if (title) out.push({ line: lineAt(src, m.index), title, level: m[1] });
    }
    return out;
}

function equationBlocks(text) {
    const src = String(text || '');
    const blocks = [];
    const env = new RegExp(`\\\\begin\\{(${EQUATION_ENVS.slice(3, -1)})\\*?\\}[\\s\\S]*?` +
        `\\\\end\\{\\1\\*?\\}`, 'g');
    for (const m of src.matchAll(env)) blocks.push(m[0]);
    for (const m of src.matchAll(/(^|[^\\])\\\[([\s\S]*?)\\\]/gm)) blocks.push(`\\[${m[2]}\\]`);
    for (const m of src.matchAll(/\$\$([\s\S]*?)\$\$/g)) blocks.push(`$$${m[1]}$$`);
    return blocks.map(x => x.replace(/%[^\n]*/g, '').replace(/\s+/g, ' ').trim());
}

function multisetDelta(oldItems, newItems) {
    const old = new Map(); const fresh = new Map();
    for (const x of oldItems) old.set(x, (old.get(x) || 0) + 1);
    for (const x of newItems) fresh.set(x, (fresh.get(x) || 0) + 1);
    let added = 0; let removed = 0;
    for (const [x, n] of fresh) added += Math.max(0, n - (old.get(x) || 0));
    for (const [x, n] of old) removed += Math.max(0, n - (fresh.get(x) || 0));
    return { added, removed };
}

function diffHunks(diff) {
    const out = [];
    const re = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
    let m;
    while ((m = re.exec(String(diff || '')))) {
        out.push({
            oldStart: Number(m[1]), oldCount: m[2] == null ? 1 : Number(m[2]),
            newStart: Number(m[3]), newCount: m[4] == null ? 1 : Number(m[4]),
        });
    }
    return out;
}

function nearestHeading(headings, line) {
    let hit = null;
    for (const h of headings) {
        if (h.line > line) break;
        hit = h;
    }
    return hit && hit.title;
}

function summarizeLatexChanges(files, totalFiles) {
    const sections = [];
    const seen = new Set();
    let added = 0; let removed = 0;
    for (const f of files || []) {
        const oldText = String(f.oldText || '');
        const newText = String(f.newText || '');
        const oldHeads = sectionHeadings(oldText);
        const newHeads = sectionHeadings(newText);
        const hunks = diffHunks(f.diff);
        const candidates = [];
        if (!oldText && newText) {
            candidates.push(...newHeads.map(h => h.title));
        } else if (oldText && !newText) {
            candidates.push(...oldHeads.map(h => h.title));
        } else if (hunks.length) {
            for (const h of hunks) {
                if (h.newCount) candidates.push(nearestHeading(newHeads, h.newStart));
                if (h.oldCount) candidates.push(nearestHeading(oldHeads, h.oldStart));
            }
        }
        for (const title of candidates.filter(Boolean)) {
            if (!seen.has(title)) { seen.add(title); sections.push(title); }
        }
        const delta = multisetDelta(equationBlocks(oldText), equationBlocks(newText));
        added += delta.added; removed += delta.removed;
    }

    const named = sections.slice(0, 3);
    const more = sections.length > named.length ? ` +${sections.length - named.length} more` : '';
    const eqShort = added || removed ? `; equations +${added}/-${removed}` : '';
    const subject = named.length
        ? `Update ${named.join(', ')}${more}${eqShort}`
        : (added || removed ? `Update equations (+${added}/-${removed})` : 'Update paper sources');
    const body = [];
    if (sections.length) body.push('Sections changed:', ...sections.map(s => `- ${s}`), '');
    body.push(`Equations: ${added} added, ${removed} removed`);
    body.push(`Files: ${Number(totalFiles) || (files || []).length} changed`);
    return { subject: subject.slice(0, 180), body: body.join('\n'), sections, equations: { added, removed } };
}

function spawnGit(executable, cwd, args, timeout = 120000, extraEnv = {}) {
    return new Promise((resolve) => {
        let stdout = ''; let stderr = ''; let settled = false;
        let child;
        try {
            child = spawn(executable, args, {
                cwd, windowsHide: true,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
            });
        } catch (error) { resolve({ code: 1, stdout, stderr: error.message, error }); return; }
        const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        child.stdout.on('data', b => { stdout += b.toString(); });
        child.stderr.on('data', b => { stderr += b.toString(); });
        child.on('error', error => finish({ code: 1, stdout, stderr: stderr || error.message, error }));
        child.on('close', code => finish({ code: code == null ? 1 : code, stdout, stderr }));
        const timer = setTimeout(() => {
            try { child.kill(); } catch (_) {}
            finish({ code: 1, stdout, stderr: `${stderr}\ngit timed out`.trim() });
        }, timeout);
    });
}

function gitCandidates(vscode) {
    const configured = vscode.workspace.getConfiguration('git').get('path');
    const fromConfig = Array.isArray(configured) ? configured : [configured];
    const candidates = [...fromConfig.filter(x => typeof x === 'string' && x), 'git'];
    if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
    if (process.platform === 'win32') {
        for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) {
            candidates.push(path.join(base, 'Git', 'cmd', 'git.exe'));
        }
    }
    return [...new Set(candidates)];
}

class GitWorkflow {
    constructor(vscode, context, opts = {}) {
        this.vscode = vscode;
        this.context = context;
        this.exec = opts.exec || null;
        this.executable = opts.executable || null;
        this._askpassDir = null;
    }

    async _run(cwd, args, opts = {}) {
        if (this.exec) return this.exec(cwd, args, opts);
        if (this.executable) return spawnGit(this.executable, cwd, args, opts.timeout || 120000, opts.env || {});
        for (const candidate of gitCandidates(this.vscode)) {
            const probe = await spawnGit(candidate, cwd, ['--version'], 10000);
            if (probe.code === 0) {
                this.executable = candidate;
                return spawnGit(candidate, cwd, args, opts.timeout || 120000, opts.env || {});
            }
        }
        return { code: 1, stdout: '', stderr: 'Git was not found. Install Git or set git.path in VS Code.' };
    }

    _secretKey(repo, remote = 'overleaf') {
        return `wolfbook.tex.overleafToken:${repo}:${remote}`;
    }

    _askpassPath() {
        let base = this.context.globalStorageUri && this.context.globalStorageUri.fsPath;
        if (!base) {
            if (!this._askpassDir) this._askpassDir = fs.mkdtempSync(
                path.join(os.tmpdir(), 'wolfbook-git-auth-'));
            base = this._askpassDir;
        }
        fs.mkdirSync(base, { recursive: true });
        if (process.platform === 'win32') {
            const file = path.join(base, 'overleaf-askpass.cmd');
            const body = [
                '@echo off',
                'echo %~1 | %SystemRoot%\\System32\\findstr.exe /I "Username" >nul',
                'if errorlevel 1 (echo %WOLFBOOK_GIT_TOKEN%) else (echo git)',
                '',
            ].join('\r\n');
            if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o700 });
            return file;
        }
        const file = path.join(base, 'overleaf-askpass.sh');
        const body = [
            '#!/bin/sh',
            'case "$1" in',
            '  *sername*) printf "%s\\n" "${WOLFBOOK_GIT_USERNAME:-git}" ;;',
            '  *) printf "%s\\n" "$WOLFBOOK_GIT_TOKEN" ;;',
            'esac',
            '',
        ].join('\n');
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o700 });
        try { fs.chmodSync(file, 0o700); } catch (_) { /* best effort */ }
        return file;
    }

    async _remoteUrl(repo, remote) {
        const got = await this._run(repo, ['remote', 'get-url', remote]);
        return got.code === 0 ? got.stdout.trim() : '';
    }

    /** Find an existing Overleaf Git remote, including one the reader named themselves. */
    async _findOverleafRemote(repo) {
        // The documented/default name covers almost every project and avoids
        // listing anything when it is present. Still inspect all names: a
        // manually configured `origin` is every bit as connected as `overleaf`.
        const named = await this._remoteUrl(repo, 'overleaf');
        if (isOverleafUrl(named)) return { name: 'overleaf', url: named };
        const remotes = await this._run(repo, ['remote']);
        if (remotes.code !== 0) return null;
        for (const name of remotes.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
            if (name === 'overleaf') continue;
            const url = await this._remoteUrl(repo, name);
            if (isOverleafUrl(url)) return { name, url };
        }
        return null;
    }

    async _overleafEnv(repo, remote) {
        const secrets = this.context.secrets;
        const token = secrets && await secrets.get(this._secretKey(repo, remote));
        if (!token) return {};
        return {
            GIT_ASKPASS: this._askpassPath(),
            GIT_ASKPASS_REQUIRE: 'force',
            WOLFBOOK_GIT_USERNAME: 'git',
            WOLFBOOK_GIT_TOKEN: token,
        };
    }

    async _promptOverleafToken(repo, remote) {
        const secrets = this.context.secrets;
        if (!secrets) return false;
        const token = await this.vscode.window.showInputBox({
            title: 'Overleaf Git authentication token',
            prompt: 'Username is “git”. The token is kept in VS Code Secret Storage, never in .git/config.',
            password: true, ignoreFocusOut: true,
        });
        if (!token) return false;
        await secrets.store(this._secretKey(repo, remote), token.trim());
        return true;
    }

    async _runRemote(repo, remote, args) {
        const url = await this._remoteUrl(repo, remote);
        const overleaf = isOverleafUrl(url);
        let env = overleaf ? await this._overleafEnv(repo, remote) : {};
        let result = await this._run(repo, args, { env });
        const authFailure = /authentication|could not read (?:username|password)|terminal prompts disabled|\b40[13]\b/i
            .test(`${result.stderr || ''}\n${result.stdout || ''}`);
        if (result.code !== 0 && overleaf && authFailure && await this._promptOverleafToken(repo, remote)) {
            env = await this._overleafEnv(repo, remote);
            result = await this._run(repo, args, { env });
        }
        return { ...result, overleaf, url };
    }

    _folderFor(file) {
        const uri = this.vscode.Uri.file(file);
        const folder = this.vscode.workspace.getWorkspaceFolder && this.vscode.workspace.getWorkspaceFolder(uri);
        return folder && folder.uri && folder.uri.fsPath || path.dirname(file);
    }

    async _repo(file, offerInit) {
        const cwd = this._folderFor(file);
        let top = await this._run(cwd, ['rev-parse', '--show-toplevel']);
        if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();
        if (/not found|ENOENT/i.test(top.stderr || '')) {
            this.vscode.window.showErrorMessage(top.stderr.trim());
            return null;
        }
        if (!offerInit) return null;
        const init = 'Initialize Git here';
        const picked = await this.vscode.window.showInformationMessage(
            `${path.basename(cwd)} is not a Git repository. Configure Git for this folder?`, init);
        if (picked !== init) return null;
        const made = await this._run(cwd, ['init']);
        if (made.code !== 0) { this._failure('Git initialization failed', made); return null; }
        top = await this._run(cwd, ['rev-parse', '--show-toplevel']);
        return top.code === 0 ? top.stdout.trim() : cwd;
    }

    async _identity(repo) {
        const name = await this._run(repo, ['config', '--get', 'user.name']);
        const email = await this._run(repo, ['config', '--get', 'user.email']);
        if (name.code === 0 && name.stdout.trim() && email.code === 0 && email.stdout.trim()) return true;
        const configure = 'Configure for this folder';
        const picked = await this.vscode.window.showInformationMessage(
            'Git needs an author name and email before it can commit.', configure);
        if (picked !== configure) return false;
        const userName = name.stdout.trim() || await this.vscode.window.showInputBox({
            title: 'Git author for this folder', prompt: 'Name stored in this repository only',
            ignoreFocusOut: true,
        });
        if (!userName) return false;
        const userEmail = email.stdout.trim() || await this.vscode.window.showInputBox({
            title: 'Git email for this folder', prompt: 'Email stored in this repository only',
            ignoreFocusOut: true,
        });
        if (!userEmail) return false;
        const a = await this._run(repo, ['config', '--local', 'user.name', userName]);
        const b = await this._run(repo, ['config', '--local', 'user.email', userEmail]);
        if (a.code !== 0 || b.code !== 0) {
            this._failure('Could not configure the Git author', a.code !== 0 ? a : b); return false;
        }
        return true;
    }

    async _pushMode(repo) {
        const key = `wolfbook.tex.gitPushMode:${repo}`;
        const store = this.context.workspaceState;
        const old = store && store.get(key);
        if (old === 'always' || old === 'separate') return old;
        const local = { label: 'Commit locally; push separately', description: 'Safer — use the push shortcut when ready', mode: 'separate' };
        const always = { label: 'Commit and push every time', description: 'Push immediately after each successful commit', mode: 'always' };
        const picked = await this.vscode.window.showQuickPick([local, always], {
            title: 'What should the WPaper commit shortcut do in this workspace?',
            placeHolder: 'You can change this later with “WPaper: Choose Commit/Push Behaviour”',
            ignoreFocusOut: true,
        });
        if (!picked) return null;
        if (store) await store.update(key, picked.mode);
        return picked.mode;
    }

    async choosePushMode(file) {
        const repo = await this._repo(file, true);
        if (!repo) return;
        const key = `wolfbook.tex.gitPushMode:${repo}`;
        if (this.context.workspaceState) await this.context.workspaceState.update(key, undefined);
        await this._pushMode(repo);
    }

    async _openUrl(value) {
        try {
            if (this.vscode.env && this.vscode.env.openExternal) {
                await this.vscode.env.openExternal(this.vscode.Uri.parse(value));
            }
        } catch (_) { /* the instructions in the dialog still stand */ }
    }

    _terminal(repo, command) {
        if (!this.vscode.window.createTerminal) return false;
        const terminal = this.vscode.window.createTerminal({ name: 'WPaper · Overleaf', cwd: repo });
        terminal.show();
        terminal.sendText(command, false); // visible and editable; the reader presses Enter
        return true;
    }

    async _configuredOverleaf(file, repo, remote) {
        const sync = 'Merge and push now';
        const remove = 'Delete current sync';
        let safeUrl = remote.url;
        const parsed = parseOverleafConnection(remote.url);
        if (!parsed.error) safeUrl = parsed.url;
        const picked = await this.vscode.window.showInformationMessage(
            'Overleaf Git sync is configured successfully.',
            { modal: true, detail: [
                `Git remote: ${remote.name}`,
                `Project: ${safeUrl}`,
                '',
                'WPaper fetches and merges Overleaf changes before pushing. Your local Git history remains the source of truth.',
            ].join('\n') }, sync, remove);
        if (picked === sync) {
            return this.push(file, { repo, remote: remote.name, remoteBranch: 'master' });
        }
        if (picked !== remove) return true;

        const confirm = 'Delete Overleaf sync';
        const approved = await this.vscode.window.showWarningMessage(
            `Delete the current Overleaf sync (${remote.name})?`,
            { modal: true, detail: 'This removes only the Git remote and WPaper’s saved Overleaf token. Local files, commits, and history are not deleted.' },
            confirm);
        if (approved !== confirm) return true;
        const removed = await this._run(repo, ['remote', 'remove', remote.name]);
        if (removed.code !== 0) {
            this._failure('Could not remove the Overleaf Git remote', removed);
            return false;
        }
        await this._run(repo, ['config', '--local', '--unset-all', 'wolfbook.overleafRemote']);
        await this._run(repo, ['config', '--local', '--unset-all', 'wolfbook.overleafBranch']);
        if (this.context.secrets && this.context.secrets.delete) {
            await this.context.secrets.delete(this._secretKey(repo, remote.name));
        }
        this.vscode.window.showInformationMessage(
            'Overleaf Git sync was removed. Your local files and Git history were kept.');
        return true;
    }

    async configureOverleaf(file) {
        // Inspect first. The leaf is a settings/status action once Git is
        // configured, not a setup wizard that forgets the existing remote.
        const repo = await this._repo(file, true);
        if (!repo) return false;
        const existing = await this._findOverleafRemote(repo);
        if (existing) return this._configuredOverleaf(file, repo, existing);

        const paste = {
            label: '$(key) Paste Overleaf Git details',
            description: 'Add Overleaf as a remote; keep its token in VS Code Secret Storage', mode: 'paste',
        };
        const terminal = {
            label: '$(terminal) Set up in the terminal',
            description: 'Prepare the documented Git command so you can inspect and run it yourself', mode: 'terminal',
        };
        const docsChoice = {
            label: '$(book) Open Overleaf Git instructions',
            description: 'Read the official Git integration and token setup', mode: 'docs',
        };
        const picked = await this.vscode.window.showQuickPick([paste, terminal, docsChoice], {
            title: 'Configure Overleaf Git sync for this WPaper project',
            placeHolder: 'Overleaf Git integration may require a premium Overleaf plan',
            ignoreFocusOut: true,
        });
        if (!picked) return false;
        if (picked.mode === 'docs') { await this._openUrl(OVERLEAF_GIT_DOCS); return true; }
        const input = await this.vscode.window.showInputBox({
            title: 'Overleaf Git project',
            prompt: 'Paste the URL, git clone command, git pull command, or Overleaf project URL. It is parsed, never executed.',
            placeHolder: 'git clone https://git@git.overleaf.com/YOUR_PROJECT_ID',
            ignoreFocusOut: true,
        });
        if (!input) return false;
        const connection = parseOverleafConnection(input);
        if (connection.error) {
            this.vscode.window.showErrorMessage(connection.error);
            return false;
        }

        if (picked.mode === 'terminal') {
            const current = await this._run(repo, ['remote', 'get-url', 'overleaf']);
            const verb = current.code === 0 ? 'set-url' : 'add';
            this._terminal(repo, `git remote ${verb} overleaf ${connection.url}`);
            const open = 'Open Git instructions';
            const action = await this.vscode.window.showInformationMessage(
                'Run the prepared remote command, then pull with “git pull overleaf master --allow-unrelated-histories --no-rebase”. Push with “git push overleaf HEAD:master”. Use username “git” and your Overleaf token as the password.',
                open);
            if (action === open) await this._openUrl(OVERLEAF_GIT_DOCS);
            return true;
        }

        let token = connection.token;
        if (!token) {
            token = await this.vscode.window.showInputBox({
                title: 'Overleaf Git authentication token',
                prompt: 'Generate it in Overleaf Account Settings. It will be stored in VS Code Secret Storage.',
                password: true, ignoreFocusOut: true,
            });
        }
        if (!token) return false;
        const current = await this._run(repo, ['remote', 'get-url', 'overleaf']);
        const configured = current.code === 0
            ? await this._run(repo, ['remote', 'set-url', 'overleaf', connection.url])
            : await this._run(repo, ['remote', 'add', 'overleaf', connection.url]);
        if (configured.code !== 0) { this._failure('Could not configure the Overleaf remote', configured); return false; }
        await this._run(repo, ['config', '--local', 'wolfbook.overleafRemote', 'overleaf']);
        await this._run(repo, ['config', '--local', 'wolfbook.overleafBranch', 'master']);
        if (this.context.secrets) await this.context.secrets.store(
            this._secretKey(repo, 'overleaf'), String(token).trim());

        const sync = 'Merge and push now';
        const commands = 'Show terminal command';
        const docs = 'Open official instructions';
        const next = await this.vscode.window.showInformationMessage(
            'Overleaf is connected as remote “overleaf”. WPaper will fetch and merge collaborators’ changes before every push.',
            sync, commands, docs);
        if (next === sync) return this.push(file, { repo, remote: 'overleaf', remoteBranch: 'master' });
        if (next === commands) this._terminal(repo,
            'git pull overleaf master --allow-unrelated-histories --no-rebase');
        if (next === docs) await this._openUrl(OVERLEAF_GIT_DOCS);
        return true;
    }

    async _saveRepoDocuments(repo) {
        const prefix = repo.endsWith(path.sep) ? repo : repo + path.sep;
        for (const doc of this.vscode.workspace.textDocuments || []) {
            const p = doc && doc.uri && doc.uri.fsPath;
            if (doc && doc.isDirty && p && (p === repo || p.startsWith(prefix))) await doc.save();
        }
    }

    async _summary(repo, changedPaths) {
        const tex = [];
        for (const rel of changedPaths.filter(p => /\.tex$/i.test(p))) {
            const old = await this._run(repo, ['show', `HEAD:${rel}`]);
            let fresh = '';
            try { fresh = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch (_) { /* deleted */ }
            const diff = await this._run(repo, ['diff', '--cached', '--unified=0', '--', rel]);
            tex.push({ path: rel, oldText: old.code === 0 ? old.stdout : '', newText: fresh,
                diff: diff.code === 0 ? diff.stdout : '' });
        }
        return summarizeLatexChanges(tex, changedPaths.length);
    }

    _failure(prefix, result) {
        const detail = String(result && (result.stderr || result.stdout) || 'unknown Git error').trim();
        this.vscode.window.showErrorMessage(`${prefix}: ${detail.slice(0, 1200)}`);
    }

    async commit(file, { forcePush = false } = {}) {
        const repo = await this._repo(file, true);
        if (!repo || !(await this._identity(repo))) return false;
        const mode = forcePush ? 'always' : await this._pushMode(repo);
        if (!mode) return false;
        await this._saveRepoDocuments(repo);
        const status = await this._run(repo, ['status', '--porcelain=v1', '-z']);
        if (status.code !== 0) { this._failure('Could not inspect Git changes', status); return false; }
        if (!status.stdout) {
            this.vscode.window.showInformationMessage('Nothing to commit in this repository.');
            return false;
        }
        const staged = await this._run(repo, ['add', '-A', '--', '.']);
        if (staged.code !== 0) { this._failure('Could not stage the changes', staged); return false; }
        const names = await this._run(repo, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD']);
        const changedPaths = names.stdout.split('\0').filter(Boolean);
        if (!changedPaths.length) {
            this.vscode.window.showInformationMessage('Nothing to commit in this repository.');
            return false;
        }
        const summary = await this._summary(repo, changedPaths);
        const subject = await this.vscode.window.showInputBox({
            title: `Commit ${changedPaths.length} changed file${changedPaths.length === 1 ? '' : 's'}`,
            prompt: summary.body.replace(/\n/g, ' · '),
            value: summary.subject,
            valueSelection: [0, summary.subject.length],
            ignoreFocusOut: true,
        });
        if (!subject || !subject.trim()) return false;
        const committed = await this._run(repo, ['commit', '-m', subject.trim(), '-m', summary.body]);
        if (committed.code !== 0) { this._failure('Git commit failed', committed); return false; }
        const rev = await this._run(repo, ['rev-parse', '--short', 'HEAD']);
        this.vscode.window.showInformationMessage(
            `Committed ${rev.stdout.trim() || 'locally'} — ${subject.trim()}`);
        if (mode === 'always') await this.push(file, { repo });
        return true;
    }

    async _remote(repo) {
        const remotes = await this._run(repo, ['remote']);
        const list = remotes.code === 0 ? remotes.stdout.split(/\r?\n/).filter(Boolean) : [];
        if (list.length) {
            if (list.length === 1) return list[0];
            const picked = await this.vscode.window.showQuickPick(list, {
                title: 'Push to which Git remote?', ignoreFocusOut: true,
            });
            return picked || null;
        }
        const add = 'Add a remote for this folder';
        const picked = await this.vscode.window.showInformationMessage(
            'This repository has no remote configured.', add);
        if (picked !== add) return null;
        const url = await this.vscode.window.showInputBox({
            title: 'Git remote URL', prompt: 'For example: git@github.com:you/paper.git',
            ignoreFocusOut: true,
        });
        if (!url) return null;
        const made = await this._run(repo, ['remote', 'add', 'origin', url.trim()]);
        if (made.code !== 0) { this._failure('Could not add the remote', made); return null; }
        return 'origin';
    }

    async _mergeRemote(repo, remote, branch, { allowUnrelated = false } = {}) {
        // Ask the remote whether the branch exists before fetching it. A new,
        // empty GitHub repository is not an error and should proceed straight
        // to its first push.
        const advertised = await this._runRemote(repo, remote,
            ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
        if (advertised.code !== 0) {
            this._failure(`Could not check ${remote} for new changes`, advertised);
            return false;
        }
        if (!advertised.stdout.trim()) return true;

        const fetched = await this._runRemote(repo, remote,
            ['fetch', '--no-tags', remote, `refs/heads/${branch}`]);
        if (fetched.code !== 0) {
            this._failure(`Could not fetch changes from ${remote}`, fetched);
            return false;
        }
        // Exit 0 means the fetched revision is already in our history. Exit 1
        // is the ordinary "needs integration" answer, not a Git failure.
        const contained = await this._run(repo, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']);
        if (contained.code === 0) return true;

        const args = ['merge', '--no-edit', '--autostash'];
        if (allowUnrelated) args.push('--allow-unrelated-histories');
        args.push('FETCH_HEAD');
        const merged = await this._run(repo, args);
        if (merged.code === 0) {
            this.vscode.window.showInformationMessage(
                `Merged new changes from ${remote}/${branch}; local changes were kept where Git could reconcile them.`);
            return true;
        }

        const unresolved = await this._run(repo, ['diff', '--name-only', '--diff-filter=U', '-z']);
        const files = unresolved.stdout.split('\0').filter(Boolean);
        if (!files.length) {
            this._failure(`Could not merge changes from ${remote}/${branch}`, merged);
            return false;
        }
        const open = 'Open Source Control';
        const abort = 'Abort merge';
        const choice = await this.vscode.window.showWarningMessage(
            `Git merged the remote changes it could, but ${files.length} file${files.length === 1 ? '' : 's'} still conflict.`,
            { modal: true, detail: `${files.slice(0, 12).join('\n')}${files.length > 12 ? '\n…' : ''}\n\nResolve the marked sections, commit, then push again.` },
            open, abort);
        if (choice === abort) {
            const stopped = await this._run(repo, ['merge', '--abort']);
            if (stopped.code !== 0) this._failure('Could not abort the merge', stopped);
            else this.vscode.window.showInformationMessage('The remote merge was aborted; your local commits remain intact.');
        } else if (choice === open) {
            try { await this.vscode.commands.executeCommand('workbench.view.scm'); } catch (_) { /* optional */ }
        }
        // A conflicted merge is intentionally left open unless the reader
        // explicitly aborts it. Git has already preserved every clean hunk.
        return false;
    }

    async push(file, opts = {}) {
        const repo = opts.repo || await this._repo(file, true);
        if (!repo) return false;
        const branch = await this._run(repo, ['branch', '--show-current']);
        if (branch.code !== 0 || !branch.stdout.trim()) {
            this.vscode.window.showWarningMessage('Git cannot push from a detached HEAD. Check out a branch first.');
            return false;
        }
        const localBranch = branch.stdout.trim();
        const upstream = await this._run(repo,
            ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        const upstreamName = upstream.code === 0 ? upstream.stdout.trim() : '';
        let remote = opts.remote || '';
        let remoteBranch = opts.remoteBranch || '';
        let hasUpstream = false;
        if (!remote && upstreamName.includes('/')) {
            const slash = upstreamName.indexOf('/');
            remote = upstreamName.slice(0, slash);
            remoteBranch = upstreamName.slice(slash + 1);
            hasUpstream = true;
        }
        if (!remote) remote = await this._remote(repo);
        if (!remote) return false;
        const remoteUrl = await this._remoteUrl(repo, remote);
        const overleaf = isOverleafUrl(remoteUrl);
        if (!remoteBranch) remoteBranch = overleaf ? 'master' : localBranch;

        // Fetch first and make a real three-way merge. This is both safer and
        // more useful than waiting for push to say "non-fast-forward": edits
        // to different paragraphs/files reconcile automatically, while actual
        // overlaps are left as explicit conflict sections for the reader.
        if (!(await this._mergeRemote(repo, remote, remoteBranch,
            { allowUnrelated: overleaf }))) return false;

        const pushArgs = overleaf
            ? ['push', ...(hasUpstream ? [] : ['--set-upstream']), remote, `HEAD:${remoteBranch}`]
            : hasUpstream ? ['push'] : ['push', '--set-upstream', remote, localBranch];
        let pushed = await this._runRemote(repo, remote, pushArgs);
        // The remote can move between fetch and push. Reconcile once more
        // rather than asking the reader to repeat the whole command.
        if (pushed.code !== 0 && /non-fast-forward|fetch first|\[rejected\]/i
            .test(`${pushed.stderr}\n${pushed.stdout}`)) {
            if (!(await this._mergeRemote(repo, remote, remoteBranch,
                { allowUnrelated: overleaf }))) return false;
            pushed = await this._runRemote(repo, remote, pushArgs);
        }
        if (pushed.code !== 0) { this._failure('Git push failed; the commit remains local', pushed); return false; }
        this.vscode.window.showInformationMessage(
            `Pushed ${localBranch}${overleaf ? ` to Overleaf (${remoteBranch})` : ' to its remote'}.`);
        return true;
    }
}

module.exports = {
    GitWorkflow, summarizeLatexChanges, sectionHeadings, equationBlocks, diffHunks,
    parseOverleafConnection, isOverleafUrl,
};
