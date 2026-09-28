'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { register, repositoryKey, profileDirectory, launchOptions } = require('../../agent-accounts');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-accounts-'));
    try {
        const roots = ['repo-a', 'repo-b'].map(name => path.join(tmp, name));
        roots.forEach(root => fs.mkdirSync(root));
        const data = new Map();
        const context = {
            subscriptions: [], globalStorageUri: { fsPath: path.join(tmp, 'storage') },
            globalState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
                update: async (key, value) => value === undefined ? data.delete(key) : data.set(key, value) },
        };
        const commands = new Map();
        const picks = [], inputs = [], notices = [], errors = [], terminals = [];
        let tree;
        let configured = process.execPath;
        const disposable = () => ({ dispose() {} });
        const vscode = {
            EventEmitter: class { constructor() { this.event = () => disposable(); } fire() {} dispose() {} },
            TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
            ThemeIcon: class {}, TreeItemCollapsibleState: { None: 0, Expanded: 2 },
            StatusBarAlignment: { Right: 2 },
            QuickPickItemKind: { Separator: -1 },
            workspace: { isTrusted: true,
                workspaceFolders: [{ uri: { scheme: 'file', fsPath: tmp } }],
                onDidChangeWorkspaceFolders: disposable,
                getConfiguration: () => ({ get: () => configured }),
            },
            extensions: { getExtension: name => name === 'vscode.git' ? {
                activate: async () => ({ getAPI: () => ({
                    repositories: roots.map(root => ({ rootUri: { scheme: 'file', fsPath: root } })),
                    onDidOpenRepository: disposable, onDidCloseRepository: disposable,
                }) }),
            } : undefined },
            commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); } },
            window: {
                createStatusBarItem: () => ({ show() {}, dispose() {} }),
                registerTreeDataProvider: (id, provider) => { tree = provider; return disposable(); },
                showQuickPick: async items => { const choose = picks.shift(); return choose ? choose(items) : undefined; },
                showInputBox: async options => {
                    const value = inputs.shift();
                    if (value !== undefined) assert.strictEqual(options.validateInput(value), undefined);
                    return value;
                },
                showInformationMessage: async () => notices.shift(),
                showWarningMessage: async () => notices.shift(),
                showErrorMessage: message => errors.push(message),
                createTerminal: options => { terminals.push(options); return { show() {} }; },
            },
        };
        register(context, vscode);
        const setMain = node => { vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: node.repo } }]; };
        const manage = node => { setMain(node); return commands.get('wolfbook.agentAccounts.manage')(node); };
        const open = node => { setMain(node); return commands.get('wolfbook.agentAccounts.open')(node); };
        const a = { repo: roots[0], provider: 'claude' };
        const b = { repo: roots[1], provider: 'claude' };
        const codex = { repo: roots[0], provider: 'codex' };
        const action = name => picks.push(items => items.find(item => item.action === name));
        assert.deepStrictEqual((await tree.getChildren()).map(node => node.repo), [tmp], 'uses main workspace folder, ignoring nested Git repos');
        vscode.workspace.workspaceFolders.push({ uri: { scheme: 'file', fsPath: roots[1] } });
        assert.deepStrictEqual((await tree.getChildren()).map(node => node.repo), [tmp], 'multi-root workspaces use their first folder');
        assert.strictEqual((await tree.getChildren({ repo: roots[0] })).length, 2);

        action('add'); inputs.push('Personal'); await manage(a);
        const personal = require('../../account-profile-store').createProfileStore(context).list()[0];
        picks.push(items => {
            const account = items.find(item => item.action === 'select' && item.id === personal.id);
            assert(account, 'saved global account is visible directly in the action menu');
            assert.strictEqual(account.description, 'Use in this folder');
            return undefined;
        });
        await manage(b);
        assert.strictEqual(tree.getTreeItem(a).description, 'Personal');
        assert.strictEqual(tree.getTreeItem(b).description, 'Default');
        assert.strictEqual(tree.getTreeItem(codex).description, 'Default');
        assert.deepStrictEqual(terminals[0].shellArgs, ['auth', 'login']);
        assert.strictEqual(terminals[0].env.CLAUDE_CONFIG_DIR, profileDirectory(context, personal));
        assert.strictEqual(terminals[0].env.ANTHROPIC_API_KEY, null);
        assert.strictEqual(terminals[0].env.CLAUDE_CODE_OAUTH_TOKEN, null);
        assert.strictEqual(terminals[0].cwd, roots[0]);
        assert.strictEqual(terminals[0].shellPath, process.execPath);
        assert.deepStrictEqual(fs.readdirSync(roots[0]), [], 'no profile metadata or credentials in repository');
        if (process.platform !== 'win32') assert.strictEqual(fs.statSync(profileDirectory(context, personal)).mode & 0o777, 0o700);

        action('add'); inputs.push('Work'); await manage(b);
        assert.notStrictEqual(terminals[0].env.CLAUDE_CONFIG_DIR, terminals[1].env.CLAUDE_CONFIG_DIR);
        await open(a);
        assert.strictEqual(terminals[2].env.CLAUDE_CONFIG_DIR, terminals[0].env.CLAUDE_CONFIG_DIR);
        action('switch'); picks.push(items => items.find(item => item.id === personal.id)); await manage(b);
        assert.strictEqual(tree.getTreeItem(b).description, 'Personal', 'share profile across repos');
        action('switch'); await manage(a);
        assert.strictEqual(tree.getTreeItem(a).description, 'Personal', 'cancel preserves selection');

        action('add'); inputs.push('OpenAI Work'); await manage(codex);
        const codexLaunch = terminals.at(-1);
        assert.deepStrictEqual(codexLaunch.shellArgs, ['-c', 'cli_auth_credentials_store="file"', 'login']);
        assert.strictEqual(codexLaunch.env.OPENAI_API_KEY, null);
        assert.notStrictEqual(codexLaunch.env.CODEX_HOME, terminals[0].env.CLAUDE_CONFIG_DIR);
        action('status'); await manage(codex);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, ['-c', 'cli_auth_credentials_store="file"', 'login', 'status']);
        assert.strictEqual(tree.getTreeItem(a).description, 'Personal');

        action('model'); inputs.push('sonnet'); await manage(a);
        action('subagentModel'); inputs.push('haiku'); await manage(a);
        await open(a);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, ['--model', 'sonnet']);
        assert.strictEqual(terminals.at(-1).env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
        await open(b);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, [], 'same account in another workspace has its own models');
        action('model'); inputs.push('custom-codex-main'); await manage(codex);
        action('subagentModel'); inputs.push('custom-codex-child'); await manage(codex);
        await open(codex);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, ['-c', 'cli_auth_credentials_store="file"', '--model', 'custom-codex-main', '-c', 'agents.default_subagent_model="custom-codex-child"']);
        action('status'); await manage(codex);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'], 'models do not affect auth actions');
        action('model'); await manage(a);
        await open(a);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, ['--model', 'sonnet'], 'cancel preserves default');
        action('model'); inputs.push(''); await manage(a);
        action('subagentModel'); inputs.push(''); await manage(a);
        await open(a);
        assert.deepStrictEqual(terminals.at(-1).shellArgs, []);
        assert.strictEqual(terminals.at(-1).env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);

        // Recreate manager over persisted state as on extension reload.
        register(context, vscode);
        assert.strictEqual(tree.getTreeItem(codex).description, 'OpenAI Work');
        assert.match(tree.getTreeItem(codex).tooltip, /Subagent model: custom-codex-child/, 'model defaults survive reload');
        action('rename'); inputs.push('Personal renamed'); await manage(a);
        assert.strictEqual(tree.getTreeItem(b).description, 'Personal renamed');
        action('forget'); await manage(a);
        assert.strictEqual(tree.getTreeItem(a).description, 'Personal renamed');
        action('forget'); notices.push('Forget profile'); await manage(a);
        assert.strictEqual(tree.getTreeItem(a).description, 'Default');
        assert.strictEqual(tree.getTreeItem(b).description, 'Default');
        assert(fs.existsSync(profileDirectory(context, personal)), 'forget retains CLI data');
        await open(a);
        assert.deepStrictEqual(terminals.at(-1).env, {}, 'default preserves usual environment');
        assert.deepStrictEqual(terminals.at(-1).shellArgs, []);

        const count = terminals.length;
        vscode.workspace.isTrusted = false;
        await open(codex);
        assert.strictEqual(terminals.length, count);
        assert.match(errors.pop(), /Trust this workspace/);
        vscode.workspace.isTrusted = true;
        configured = path.join(tmp, 'missing-cli');
        await open(codex);
        assert.strictEqual(terminals.length, count);
        assert.match(errors.pop(), /executable not found/);
        assert.strictEqual(errors.length, 0);
        assert.notStrictEqual(repositoryKey(roots[0], 'claude'), repositoryKey(roots[0], 'codex'));
        assert.strictEqual(repositoryKey(roots[0], 'claude'), repositoryKey(roots[0] + path.sep, 'claude'));
        assert.throws(() => profileDirectory(context, { provider: 'claude', id: '../escape' }), /Invalid/);
        assert.throws(() => launchOptions('unknown', tmp), /Invalid/);
        assert.throws(() => launchOptions('claude', tmp, 'arbitrary'), /Invalid/);
        assert.strictEqual(launchOptions('claude', '/a path/with "quotes"/$shell').env.CLAUDE_CONFIG_DIR, '/a path/with "quotes"/$shell');
        console.log('Account profiles: repository selection, persistence, isolation, login/status, cancellation, removal, trust, and executable errors passed.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
