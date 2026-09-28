'use strict';

// Only profile metadata is stored by Wolfbook. The CLIs own their credentials.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROVIDERS = { claude: 'Claude Code', codex: 'Codex CLI' };
const PROFILE_KEY = 'agentAccounts.profiles';

function repositoryKey(repo, provider) {
    let root = path.resolve(repo);
    try { root = fs.realpathSync(root); } catch (_) { /* missing folder */ }
    if (process.platform === 'win32') root = root.toLowerCase();
    return `agentAccounts.repo.${crypto.createHash('sha256').update(root).digest('hex')}.${provider}`;
}

function profileDirectory(context, profile) {
    if (!PROVIDERS[profile.provider] || !/^[a-f0-9-]{36}$/.test(profile.id)) {
        throw new Error('Invalid account profile.');
    }
    return path.join(context.globalStorageUri.fsPath, 'agent-accounts', profile.provider, profile.id);
}

function launchOptions(provider, directory, action = 'open') {
    if (!PROVIDERS[provider] || !['open', 'login', 'status'].includes(action)) {
        throw new Error('Invalid account action.');
    }
    const env = {};
    const args = [];
    if (directory) {
        if (provider === 'claude') {
            env.CLAUDE_CONFIG_DIR = directory;
            // Explicit account profiles must not inherit a different session's auth.
            for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
                'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK',
                'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL',
                'ANTHROPIC_PROFILE', 'ANTHROPIC_DEFAULT_PROFILE']) env[key] = null;
        } else {
            env.CODEX_HOME = directory;
            for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) env[key] = null;
            // Pin storage for every action, including login, regardless of repo config.
            args.push('-c', 'cli_auth_credentials_store="file"');
        }
    }
    if (action !== 'open') args.push(...(provider === 'claude'
        ? ['auth', action === 'login' ? 'login' : 'status']
        : ['login', ...(action === 'status' ? ['status'] : [])]));
    return { env, args };
}

function resolveExecutable(vscode, provider) {
    const configured = vscode.workspace.getConfiguration('wolfbook.agentAccounts').get(`${provider}Executable`, '');
    const name = process.platform === 'win32' ? `${provider}.exe` : provider;
    const candidates = configured ? [configured] : [
        path.join(os.homedir(), '.local', 'bin', name),
        ...String(process.env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p)).map(p => path.join(p, name)),
        ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'].map(p => path.join(p, name))),
    ];
    if (!configured && provider === 'codex') {
        const extension = vscode.extensions.getExtension('openai.chatgpt');
        const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
        const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
        if (extension && platform && arch) candidates.push(path.join(extension.extensionPath, 'bin', `${platform}-${arch}`, name));
    }
    for (const candidate of candidates) {
        if (!path.isAbsolute(candidate)) continue;
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (_) { /* try next installation */ }
    }
    throw new Error(`${PROVIDERS[provider]} executable not found. Install its CLI or set wolfbook.agentAccounts.${provider}Executable to the full executable path.`);
}

function register(context, vscode = require('vscode')) {
    const changed = new vscode.EventEmitter();
    let gitApi;
    let gitPromise;
    const profiles = provider => context.globalState.get(PROFILE_KEY, []).filter(p => p.provider === provider);
    const selected = (repo, provider) => profiles(provider).find(p => p.id === context.globalState.get(repositoryKey(repo, provider)));
    const refresh = () => changed.fire();

    async function repositories() {
        if (!gitPromise) gitPromise = (async () => {
            const git = vscode.extensions.getExtension('vscode.git');
            if (!git) return;
            try {
                gitApi = (await git.activate()).getAPI(1);
                context.subscriptions.push(gitApi.onDidOpenRepository(refresh), gitApi.onDidCloseRepository(refresh));
            } catch (_) { /* workspace folder fallback when Git is disabled */ }
        })();
        await gitPromise;
        const roots = (gitApi?.repositories || []).map(r => r.rootUri).filter(uri => uri.scheme === 'file');
        for (const folder of vscode.workspace.workspaceFolders || []) {
            if (folder.uri.scheme !== 'file') continue;
            const root = folder.uri.fsPath;
            if (!roots.some(uri => {
                const rel = path.relative(root, uri.fsPath);
                const inverse = path.relative(uri.fsPath, root);
                return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
                    || (!inverse.startsWith(`..${path.sep}`) && inverse !== '..' && !path.isAbsolute(inverse));
            })) roots.push(folder.uri);
        }
        return [...new Set(roots.map(uri => uri.fsPath))];
    }

    async function chooseTarget(node) {
        const roots = await repositories();
        let repo = node?.repo;
        if (!roots.includes(repo)) {
            if (!roots.length) {
                vscode.window.showInformationMessage('Open a repository or workspace folder to manage CLI accounts.');
                return;
            }
            repo = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(
                roots.map(root => ({ label: path.basename(root), description: root, repo: root })),
                { title: 'Choose repository' }))?.repo;
        }
        if (!repo) return;
        const provider = PROVIDERS[node?.provider] ? node.provider : (await vscode.window.showQuickPick(
            Object.entries(PROVIDERS).map(([id, label]) => ({ label, id })),
            { title: `CLI account for ${path.basename(repo)}` }))?.id;
        return provider ? { repo, provider } : undefined;
    }

    async function launch(target, profile, action) {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting an account session.');
        const executable = resolveExecutable(vscode, target.provider);
        const directory = profile ? profileDirectory(context, profile) : undefined;
        if (directory) await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const { env, args } = launchOptions(target.provider, directory, action);
        // Launch the executable directly: no shell interpolation, startup scripts,
        // global environment edits, or injection of commands into existing terminals.
        const terminal = vscode.window.createTerminal({
            name: `${PROVIDERS[target.provider]} · ${profile?.name || 'Default'} · ${path.basename(target.repo)} · ${action}`,
            cwd: target.repo, shellPath: executable, shellArgs: args, env,
            strictEnv: false, isTransient: true,
        });
        terminal.show();
    }

    async function manage(node) {
        const target = await chooseTarget(node);
        if (!target) return;
        const { repo, provider } = target;
        const current = selected(repo, provider);
        const choice = await vscode.window.showQuickPick([
            { label: '$(terminal) Open CLI', action: 'open', description: current?.name || 'Default account' },
            { label: '$(account) Switch account for this repository…', action: 'switch' },
            { label: '$(add) Add account profile…', action: 'add' },
            { label: '$(sign-in) Sign in to selected account', action: 'login' },
            { label: '$(info) Check selected account', action: 'status' },
            ...(current ? [
                { label: '$(edit) Rename selected profile…', action: 'rename' },
                { label: '$(close) Forget selected profile…', action: 'forget' },
            ] : []),
        ], { title: `${PROVIDERS[provider]} — ${path.basename(repo)} — ${current?.name || 'Default'}`,
            placeHolder: 'Account selection applies to new CLI sessions opened through Wolfbook' });
        if (!choice) return;
        if (['open', 'login', 'status'].includes(choice.action)) return launch(target, current, choice.action);
        if (choice.action === 'switch') {
            const picked = await vscode.window.showQuickPick([
                { label: 'Default account', description: 'Use the CLI’s normal environment and login', id: undefined },
                ...profiles(provider).map(p => ({ label: p.name, id: p.id, description: p.id === current?.id ? 'Selected' : '' })),
            ], { title: `Select ${PROVIDERS[provider]} account for ${path.basename(repo)}` });
            if (!picked) return;
            await context.globalState.update(repositoryKey(repo, provider), picked.id);
            refresh();
            const open = await vscode.window.showInformationMessage(`Selected ${picked.label}. Existing CLI sessions keep their current account.`, 'Open CLI');
            if (open) await launch(target, selected(repo, provider), 'open');
            return;
        }
        if (choice.action === 'forget') {
            const answer = await vscode.window.showWarningMessage(
                `Forget “${current.name}” for all repositories? Its saved CLI data is retained; repositories using it return to Default.`,
                { modal: true }, 'Forget profile');
            if (!answer) return;
            await context.globalState.update(PROFILE_KEY, context.globalState.get(PROFILE_KEY, []).filter(p => p.id !== current.id));
            refresh();
            return;
        }
        const name = await vscode.window.showInputBox({
            title: choice.action === 'rename' ? 'Rename account profile' : `New ${PROVIDERS[provider]} account profile`,
            prompt: 'A local label, such as Personal or Work. Sign in using the CLI after creating it.',
            value: choice.action === 'rename' ? current.name : '',
            validateInput: value => !value.trim() ? 'Enter a name.' : value.trim().length > 80 ? 'Use at most 80 characters.'
                : profiles(provider).some(p => p.id !== (choice.action === 'rename' ? current.id : undefined)
                    && p.name.toLowerCase() === value.trim().toLowerCase()) ? 'That profile name already exists.' : undefined,
        });
        if (!name?.trim()) return;
        const all = context.globalState.get(PROFILE_KEY, []);
        if (choice.action === 'rename') {
            await context.globalState.update(PROFILE_KEY, all.map(p => p.id === current.id ? { ...p, name: name.trim() } : p));
        } else {
            const profile = { id: crypto.randomUUID(), provider, name: name.trim() };
            await fs.promises.mkdir(profileDirectory(context, profile), { recursive: true, mode: 0o700 });
            await context.globalState.update(PROFILE_KEY, [...all, profile]);
            await context.globalState.update(repositoryKey(repo, provider), profile.id);
            refresh();
            await launch(target, profile, 'login');
        }
        refresh();
    }

    const tree = {
        onDidChangeTreeData: changed.event,
        getTreeItem(node) {
            const item = new vscode.TreeItem(node.provider ? PROVIDERS[node.provider] : path.basename(node.repo),
                node.provider ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.provider ? repositoryKey(node.repo, node.provider) : node.repo;
            item.tooltip = node.repo;
            if (node.provider) {
                item.description = selected(node.repo, node.provider)?.name || 'Default';
                item.iconPath = new vscode.ThemeIcon('account');
                item.command = { command: 'wolfbook.agentAccounts.manage', title: 'Manage account', arguments: [node] };
                item.contextValue = 'wolfbookAgentAccount';
            } else item.iconPath = new vscode.ThemeIcon('repo');
            return item;
        },
        async getChildren(node) {
            return node ? (node.provider ? [] : Object.keys(PROVIDERS).map(provider => ({ repo: node.repo, provider })))
                : (await repositories()).map(repo => ({ repo }));
        },
    };
    const guarded = fn => async (...args) => {
        try {
            if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before managing CLI accounts.');
            return await fn(...args);
        } catch (error) { vscode.window.showErrorMessage(`Wolfbook accounts: ${error.message}`); }
    };
    context.subscriptions.push(changed,
        vscode.window.registerTreeDataProvider('wolfbook.agentAccounts', tree),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.commands.registerCommand('wolfbook.agentAccounts.manage', guarded(manage)),
        vscode.commands.registerCommand('wolfbook.agentAccounts.refresh', refresh),
        vscode.commands.registerCommand('wolfbook.agentAccounts.open', guarded(async node => {
            const target = await chooseTarget(node);
            if (target) await launch(target, selected(target.repo, target.provider), 'open');
        })));
    const accountItem = vscode.window.createStatusBarItem(
        'wolfbook-cli-accounts', vscode.StatusBarAlignment.Right, 97
    );
    accountItem.name = 'Wolfbook CLI Accounts';
    accountItem.text = '$(account)';
    accountItem.tooltip = 'Manage Claude Code and Codex accounts for this repository';
    accountItem.command = 'wolfbook.agentAccounts.manage';
    accountItem.accessibilityInformation = { label: 'Manage Wolfbook CLI accounts', role: 'button' };
    context.subscriptions.push(accountItem);
    accountItem.show();
}

module.exports = { register, repositoryKey, profileDirectory, launchOptions, resolveExecutable };
