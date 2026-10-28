'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { OverleafConnector, safeRemotePath, texFiles, RECENT_KEY, PENDING_KEY } = require('../../tex/overleafConnector');
const { OverleafLive, ACCEPTED_KEY } = require('../../tex/overleafLive');
const { cookieKey } = require('../../tex/overleafLink');
const { GitWorkflow } = require('../../tex/gitWorkflow');
const { FakeOverleaf } = require('../../tex/overleafFakeService.cjs');
const ID = '0123456789abcdef01234567', BASE = 'https://www.overleaf.com';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-overleaf-open-'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let serial = 0;
function fixture({ emptyWorkspace = false, docs, binaries } = {}) {
    const parent = path.join(testRoot, `case-${++serial}`); fs.mkdirSync(parent);
    const storage = new Map([[ACCEPTED_KEY, true]]), secrets = new Map([[cookieKey(BASE), 'overleaf_session2=good']]);
    const server = new FakeOverleaf(docs || { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\\includegraphics{fig/a.png}\\end{document}', 'sections/body.tex': 'Original body', 'refs.bib': '@article{one}', 'custom.sty': '% style', '.latexmkrc': '$pdf_mode=1;' }, binaries || { 'fig/a.png': Buffer.from([137, 80, 78, 71]) });
    const tree = server.tree.bind(server);
    server.tree = () => ({ ...tree(), rootDoc_id: [...server.docs].find(([, d]) => d.name === 'main.tex')?.[0] });
    const calls = { commands: [], errors: [], additions: [], inputs: [], configs: [] };
    const docsOpen = [];
    const modes = new Map();
    const change = [];
    const configFor = file => [...modes.keys()].sort((a, b) => b.length - a.length).find(root => file === root || file.startsWith(root + path.sep));
    const vscode = {
        Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }, ProgressLocation: { Notification: 15 },
        workspace: {
            workspaceFolders: emptyWorkspace ? [] : [{ uri: { fsPath: parent } }],
            getWorkspaceFolder: uri => vscode.workspace.workspaceFolders.filter(f => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep)).at(-1),
            getConfiguration: (_section, uri) => ({ get: (key, def) => key === 'overleafSync' ? modes.get(configFor(uri?.fsPath || '')) || 'git' : def,
                update: async (key, value, scope) => { calls.configs.push({ key, value, scope, uri }); modes.set(uri.fsPath, value); } }),
            updateWorkspaceFolders: (index, remove, ...items) => { calls.additions.push(items); vscode.workspace.workspaceFolders.splice(index, remove, ...items); return true; },
            onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
            onDidChangeTextDocument: handler => { change.push(handler); return { dispose() {} }; },
            openTextDocument: async uri => {
                let doc = docsOpen.find(d => d.uri.fsPath === uri.fsPath);
                if (!doc) { doc = { uri, version: 1, isClosed: false, isDirty: false, text: fs.readFileSync(uri.fsPath, 'utf8'), getText() { return this.text; },
                    positionAt(offset) { return { offset }; }, save: async () => { fs.writeFileSync(uri.fsPath, doc.text); doc.isDirty = false; return true; } }; docsOpen.push(doc); }
                return doc;
            },
            get textDocuments() { return docsOpen; },
        },
        window: {
            activeTextEditor: null,
            showInputBox: async options => { calls.inputs.push(options); return options.password ? 'GIT_SECRET' : `${BASE}/project/${ID}`; },
            showQuickPick: async choices => choices.find(p => p.file === 'sections/body.tex') || choices[0],
            showOpenDialog: async () => [{ fsPath: parent }],
            showTextDocument: async doc => { vscode.window.activeTextEditor = { document: doc }; },
            showErrorMessage: message => calls.errors.push(message), showWarningMessage: async () => undefined,
            showInformationMessage: () => undefined,
            withProgress: async (_opts, fn) => fn({ report() {} }),
            onDidChangeTextEditorSelection: () => ({ dispose() {} }),
        },
        commands: { executeCommand: async (...args) => { calls.commands.push(args); } },
    };
    const context = {
        globalState: { get: key => storage.get(key), update: async (key, value) => { storage.set(key, value); } },
        secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key) },
        globalStorageUri: { fsPath: path.join(parent, 'storage') },
    };
    const live = new OverleafLive({ vscode, context, target: () => vscode.window.activeTextEditor?.document.uri.fsPath, deps: server.deps() });
    const git = new GitWorkflow(vscode, context);
    const connector = new OverleafConnector({ vscode, context, live, git });
    const edit = (doc, text) => {
        const old = doc.text; doc.text = text; doc.version++; doc.isDirty = true;
        for (const handler of change) handler({ document: doc, contentChanges: [{ rangeOffset: 0, rangeLength: old.length, text }] });
    };
    return { parent, storage, secrets, server, calls, vscode, context, live, git, connector, edit };
}

test('live browse opens a selected fragment, brings all sources/assets locally, and edits the remote through the existing link', async () => {
    const f = fixture();
    try {
        const state = await f.connector.status({ refresh: true });
        assert.strictEqual(state.account, 'connected'); assert.strictEqual(state.projects[0].id, ID);
        assert.ok(!JSON.stringify(state).includes('overleaf_session2'));
        assert.strictEqual(await f.connector.openLive(ID), true, f.calls.errors.join('\n'));
        const entry = f.storage.get(RECENT_KEY)[0];
        assert.strictEqual(entry.main, 'main.tex'); assert.strictEqual(entry.file, 'sections/body.tex');
        for (const name of ['main.tex', 'sections/body.tex', 'refs.bib', 'custom.sty', '.latexmkrc', 'fig/a.png']) assert.ok(fs.existsSync(path.join(entry.root, name)), name);
        assert.deepStrictEqual(fs.readFileSync(path.join(entry.root, 'fig/a.png')), Buffer.from([137, 80, 78, 71]));
        assert.ok(f.vscode.workspace.workspaceFolders.some(p => p.uri.fsPath === entry.root), 'agents see the project workspace folder');
        assert.strictEqual(f.live.mode(), 'live');
        assert.deepStrictEqual(f.calls.commands.at(-1), ['wolfbook.tex.openViewer', { root: path.join(entry.root, 'main.tex') }]);
        assert.strictEqual(f.live.link.state.status, 'connected');
        const doc = f.vscode.window.activeTextEditor.document;
        f.edit(doc, 'AI agent and reader edit');
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.ok([...f.server.docs.values()].some(d => d.name === 'sections/body.tex' && d.text === 'AI agent and reader edit'));
        f.vscode.window.showQuickPick = async () => undefined;
        const before = fs.readdirSync(f.parent).length;
        assert.strictEqual(await f.connector.openLive(ID), false, 'opening an already local project uses the file picker');
        assert.strictEqual(fs.readdirSync(f.parent).length, before, 'does not make duplicate copies or overwrite edits');
        await f.connector.disconnectAccount();
        assert.strictEqual(await f.context.secrets.get(cookieKey(BASE)), undefined);
        assert.ok(fs.existsSync(path.join(entry.root, 'main.tex')));
    } finally { f.live.dispose(); }
});

test('explicitly selected sources outside the main document remain live editable', async () => {
    const f = fixture({ docs: { 'main.tex': '\\documentclass{article}\\begin{document}Main\\end{document}', 'extras/note.tex': 'Unreferenced source' } });
    f.vscode.window.showQuickPick = async choices => choices.find(c => c.file === 'extras/note.tex') || choices[0];
    try {
        await f.connector.status({ refresh: true });
        assert.strictEqual(await f.connector.openLive(ID), true, f.calls.errors.join('\n'));
        f.edit(f.vscode.window.activeTextEditor.document, 'Edited unreferenced source');
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.ok([...f.server.docs.values()].some(d => d.name === 'extras/note.tex' && d.text === 'Edited unreferenced source'));
    } finally { f.live.dispose(); }
});

test('first folder handoff resumes WPaper and live sync after extension-host activation', async () => {
    const f = fixture({ emptyWorkspace: true });
    try {
        await f.connector.status({ refresh: true });
        assert.strictEqual(await f.connector.openLive(ID), true);
        assert.ok(f.storage.get(PENDING_KEY));
        assert.strictEqual(f.calls.commands.length, 0, 'no viewer command before the first-folder handoff');
        assert.strictEqual(f.live.link.client, null);
        await f.connector.resume();
        assert.strictEqual(f.storage.get(PENDING_KEY), undefined);
        assert.strictEqual(f.live.link.state.status, 'connected');
        assert.ok(f.calls.commands.some(c => c[0] === 'wolfbook.tex.openViewer'));
    } finally { f.live.dispose(); }
});

test('path validation, cancellation and partial download failure preserve unrelated local files', async () => {
    for (const name of ['../bad.tex', '/bad.tex', 'a/../../bad.tex', 'a\\bad.tex', 'C:/bad.tex', '.git/config', 'a/.overleaf/settings', 'a\u0000.tex']) assert.throws(() => safeRemotePath(name));
    assert.strictEqual(safeRemotePath('sections/intro.tex'), 'sections/intro.tex');
    const f = fixture();
    try {
        const kept = path.join(f.parent, 'Fishnets'); fs.mkdirSync(kept); fs.writeFileSync(path.join(kept, 'main.tex'), 'LOCAL_EDITS');
        await f.connector.status({ refresh: true });
        f.connector.fetch = async () => ({ ok: false, status: 503 });
        assert.strictEqual(await f.connector.openLive(ID), false);
        assert.strictEqual(fs.readFileSync(path.join(kept, 'main.tex'), 'utf8'), 'LOCAL_EDITS');
        assert.ok(!fs.existsSync(path.join(f.parent, 'Fishnets-2')));
        assert.strictEqual(f.calls.additions.length, 0);
        assert.ok(f.calls.errors.some(e => e.includes('503')));
        f.vscode.window.showQuickPick = async () => undefined;
        assert.strictEqual(await f.connector.openLive(ID), false);
    } finally { f.live.dispose(); }
});

test('expired account session shows an error instead of silently displaying an empty project list', async () => {
    const f = fixture();
    try {
        f.secrets.set(cookieKey(BASE), 'overleaf_session2=expired');
        const state = await f.connector.status({ refresh: true });
        assert.strictEqual(state.account, 'error'); assert.match(state.detail, /expired|refused/);
        assert.deepStrictEqual(state.projects, []);
    } finally { f.live.dispose(); }
});

test('Git open clones a main-branch project, keeps auth outside URLs, opens WPaper and follows the actual remote branch', async () => {
    const f = fixture();
    const runGit = (cwd, args) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    };
    try {
        const seed = path.join(f.parent, 'seed'); fs.mkdirSync(seed);
        for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com']]) assert.strictEqual(runGit(seed, args).code, 0);
        fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');
        fs.writeFileSync(path.join(seed, 'other.tex'), 'Other file');
        assert.strictEqual(runGit(seed, ['add', '.']).code, 0); assert.strictEqual(runGit(seed, ['commit', '-m', 'fixture']).code, 0);
        const ops = [];
        f.git.exec = async (cwd, args, options = {}) => {
            ops.push({ cwd, args, options });
            if (args[0] === 'clone') { assert.ok(options.env.WOLFBOOK_GIT_TOKEN); assert.ok(!args.join(' ').includes('GIT_SECRET')); return runGit(cwd, ['clone', '--origin', 'overleaf', '--', seed, args.at(-1)]); }
            return runGit(cwd, args);
        };
        assert.strictEqual(await f.connector.openGit(), true, f.calls.errors.join('\n'));
        const entry = f.storage.get(RECENT_KEY)[0];
        assert.strictEqual(f.live.mode(), 'git'); assert.ok(fs.existsSync(path.join(entry.root, 'other.tex')));
        assert.strictEqual(await f.git._overleafBranch(entry.root, 'overleaf'), 'main');
        assert.strictEqual(await f.context.secrets.get(f.git._secretKey(entry.root, 'overleaf')), 'GIT_SECRET');
        assert.ok(!fs.readFileSync(path.join(entry.root, '.git/config'), 'utf8').includes('GIT_SECRET'));
        assert.ok(!ops.some(o => o.args[0] === 'push'), 'opening does not push');
        assert.ok(f.calls.commands.some(c => c[0] === 'wolfbook.tex.openViewer'));
        assert.deepStrictEqual(await texFiles(entry.root), ['main.tex', 'other.tex']);
        // Discover remote HEAD when there is no saved branch: current main and legacy master.
        for (const branch of ['main', 'master']) {
            const discover = new GitWorkflow(f.vscode, f.context, { exec: async (_cwd, args) => args[0] === 'config' ? { code: 1, stdout: '' } : { code: 0, stdout: `ref: refs/heads/${branch}\tHEAD\nabc\tHEAD\n` } });
            assert.strictEqual(await discover._overleafBranch(entry.root, 'overleaf'), branch);
        }
    } finally { f.live.dispose(); }
});

(async () => {
    let failed = 0;
    try {
        for (const { name, fn } of tests) {
            try { await fn(); console.log('✓ ' + name); }
            catch (error) { failed++; console.error('✗ ' + name, error); }
        }
    } finally { fs.rmSync(testRoot, { recursive: true, force: true }); }
    console.log(`${tests.length - failed}/${tests.length} Overleaf connector checks passed`);
    process.exit(failed ? 1 : 0);
})();
