'use strict';

// Only profile metadata is stored by Wolfbook. The CLIs own their credentials.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROVIDERS = { claude: 'Claude Code', codex: 'Codex CLI' };

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

function launchOptions(provider, directory, action = 'open', models = {}) {
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
    if (action === 'open') {
        if (models.model) args.push('--model', models.model);
        if (models.subagentModel) {
            if (provider === 'claude') env.CLAUDE_CODE_SUBAGENT_MODEL = models.subagentModel;
            else args.push('-c', `agents.default_subagent_model=${JSON.stringify(models.subagentModel)}`);
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
    const profileStore = require('./account-profile-store').createProfileStore(context);
    const profiles = provider => profileStore.list().filter(p => p.provider === provider);
    const selected = (repo, provider) => profiles(provider).find(p => p.id === context.globalState.get(repositoryKey(repo, provider)));
    const modelDefaults = (repo, provider) => context.globalState.get(`${repositoryKey(repo, provider)}.models`, {});
    const panel = require('./claude-panel-accounts').createBridge(context, vscode,
        () => require('./claude-mcp/server').resolveNodeBinary());
    let panelSync = Promise.resolve();
    let disposed = false;
    context.subscriptions.push({ dispose() { disposed = true; } });
    async function prepareProfile(profile) {
        if (!profile) return;
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before configuring an account session.');
        const node = process.versions.electron ? require('./claude-mcp/server').resolveNodeBinary() : process.execPath;
        const mcp = require('./account-profile-mcp');
        if (profile.provider === 'claude') mcp.ensureClaudeProfileMcp(profileDirectory(context, profile), node);
        else await mcp.ensureCodexProfileMcp(profileDirectory(context, profile), node, resolveExecutable(vscode, 'codex'));
    }
    function syncPanel() {
        panelSync = panelSync.catch(() => {}).then(async () => {
            if (disposed) return false;
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (root?.scheme !== 'file' || !vscode.workspace.isTrusted) { panel.clear(); return false; }
            const profile = selected(root.fsPath, 'claude');
            await prepareProfile(profile);
            const models = modelDefaults(root.fsPath, 'claude');
            const { env } = launchOptions('claude', profile ? profileDirectory(context, profile) : undefined, 'open', models);
            if (models.model) env.ANTHROPIC_MODEL = models.model;
            return panel.sync(root.fsPath, env, !!profile || Object.keys(models).length > 0);
        });
        return panelSync;
    }
    const refresh = () => {
        changed.fire();
        syncPanel().catch(error => vscode.window.showErrorMessage(`Wolfbook Claude panel: ${error.message}`));
    };

    async function workspaceRoots() {
        // Account/model scope is the window's main workspace folder, not a
        // nested Git repository or the folder of the active editor.
        const main = vscode.workspace.workspaceFolders?.[0]?.uri;
        return main?.scheme === 'file' ? [main.fsPath] : [];
    }

    async function chooseTarget(node) {
        const roots = await workspaceRoots();
        let repo = node?.repo;
        if (!roots.includes(repo)) {
            if (!roots.length) {
                vscode.window.showInformationMessage('Open a workspace folder to manage CLI accounts.');
                return;
            }
            repo = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(
                roots.map(root => ({ label: path.basename(root), description: root, repo: root })),
                { title: 'Choose workspace folder' }))?.repo;
        }
        if (!repo) return;
        const provider = PROVIDERS[node?.provider] ? node.provider : (await vscode.window.showQuickPick(
            Object.entries(PROVIDERS).map(([id, label]) => ({
                label, id, description: `Selected: ${selected(repo, id)?.name || 'Default account'}`,
            })),
            { title: `CLI account for ${path.basename(repo)}` }))?.id;
        return provider ? { repo, provider } : undefined;
    }

    async function launch(target, profile, action) {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting an account session.');
        const executable = resolveExecutable(vscode, target.provider);
        const directory = profile ? profileDirectory(context, profile) : undefined;
        if (directory) await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        await prepareProfile(profile);
        const { env, args } = launchOptions(target.provider, directory, action, modelDefaults(target.repo, target.provider));
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
        const models = modelDefaults(repo, provider);
        const choice = await vscode.window.showQuickPick([
            { label: 'Saved accounts — all windows', kind: vscode.QuickPickItemKind.Separator },
            { label: `${current ? '$(account)' : '$(check)'} Default account`, action: 'select', id: undefined,
                description: current ? 'Use the CLI’s normal login' : 'Selected for this folder' },
            ...profiles(provider).map(profile => ({
                label: `${profile.id === current?.id ? '$(check)' : '$(account)'} ${profile.name}`,
                action: 'select', id: profile.id,
                description: profile.id === current?.id ? 'Selected for this folder' : 'Use in this folder',
            })),
            { label: 'Actions', kind: vscode.QuickPickItemKind.Separator },
            ...(provider === 'claude' && panel.supported() ? [{ label: '$(comment-discussion) Open Claude panel with selected account', action: 'panel' }] : []),
            { label: '$(terminal) Open CLI', action: 'open', description: current?.name || 'Default account' },
            { label: '$(account) Switch account for this workspace folder…', action: 'switch' },
            { label: '$(settings-gear) Default model for this workspace folder…', action: 'model', description: models.model || 'CLI default' },
            { label: '$(organization) Default subagent model for this workspace folder…', action: 'subagentModel', description: models.subagentModel || 'CLI default' },
            { label: '$(add) Add account profile…', action: 'add' },
            { label: '$(sign-in) Sign in to selected account', action: 'login' },
            { label: '$(info) Check selected account', action: 'status' },
            ...(current ? [
                { label: '$(edit) Rename selected profile…', action: 'rename' },
                { label: '$(close) Forget selected profile…', action: 'forget' },
            ] : []),
        ], { title: `${PROVIDERS[provider]} — ${path.basename(repo)} — ${current?.name || 'Default'}`,
            placeHolder: provider === 'claude' && panel.supported() ? 'Selection applies to new Claude panel and Wolfbook CLI sessions' : 'Selection applies to new CLI sessions opened through Wolfbook' });
        if (!choice) return;
        if (choice.action === 'panel') {
            await syncPanel();
            // Start a fresh conversation: existing CLI processes retain their
            // original environment and cannot safely change account mid-turn.
            await vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
            return;
        }
        if (['model', 'subagentModel'].includes(choice.action)) {
            const value = await vscode.window.showInputBox({
                title: `${PROVIDERS[provider]} — ${choice.action === 'model' ? 'Default model' : 'Default subagent model'} — ${path.basename(repo)}`,
                prompt: 'Enter a model ID or supported alias. Leave blank to use the CLI’s own defaults. Applies to new Wolfbook CLI sessions.',
                placeHolder: provider === 'claude' ? 'For example: opus, sonnet, haiku, or a full model ID' : 'Enter a Codex model ID supported by your account',
                value: models[choice.action] || '',
                validateInput: text => text.trim() && (/\s|[\u0000-\u001f\u007f]/.test(text.trim()) || text.trim().startsWith('-') || text.trim().length > 200)
                    ? 'Use a model ID or alias without spaces (at most 200 characters).' : undefined,
            });
            if (value === undefined) return;
            const updated = { ...modelDefaults(repo, provider) };
            if (value.trim()) updated[choice.action] = value.trim();
            else delete updated[choice.action];
            await context.globalState.update(`${repositoryKey(repo, provider)}.models`, Object.keys(updated).length ? updated : undefined);
            refresh();
            return;
        }
        if (['open', 'login', 'status'].includes(choice.action)) return launch(target, current, choice.action);
        if (choice.action === 'switch' || choice.action === 'select') {
            const picked = choice.action === 'select' ? choice : await vscode.window.showQuickPick([
                { label: 'Default account', description: 'Use the CLI’s normal environment and login', id: undefined },
                ...profiles(provider).map(p => ({ label: p.name, id: p.id, description: p.id === current?.id ? 'Selected' : '' })),
            ], { title: `Select ${PROVIDERS[provider]} account for ${path.basename(repo)}` });
            if (!picked) return;
            await prepareProfile(profiles(provider).find(profile => profile.id === picked.id));
            await context.globalState.update(repositoryKey(repo, provider), picked.id);
            refresh();
            const options = provider === 'claude' && panel.supported() ? ['Open Claude panel', 'Open CLI'] : ['Open CLI'];
            const open = await vscode.window.showInformationMessage(`Selected ${profiles(provider).find(profile => profile.id === picked.id)?.name || 'Default account'}. Open a new conversation to use this account; existing sessions keep their account.`, ...options);
            if (open === 'Open Claude panel') { await syncPanel(); await vscode.commands.executeCommand('claude-vscode.primaryEditor.open'); }
            else if (open === 'Open CLI') await launch(target, selected(repo, provider), 'open');
            return;
        }
        if (choice.action === 'forget') {
            const answer = await vscode.window.showWarningMessage(
                `Forget “${current.name}” for all workspace folders? Its saved CLI data is retained; workspace folders using it return to Default.`,
                { modal: true }, 'Forget profile');
            if (!answer) return;
            profileStore.remove(current);
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
        if (choice.action === 'rename') {
            profileStore.save({ ...current, name: name.trim() });
        } else {
            const profile = { id: crypto.randomUUID(), provider, name: name.trim() };
            await fs.promises.mkdir(profileDirectory(context, profile), { recursive: true, mode: 0o700 });
            profileStore.save(profile);
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
                const models = modelDefaults(node.repo, node.provider);
                item.description = selected(node.repo, node.provider)?.name || 'Default';
                item.tooltip = `${node.repo}\nModel: ${models.model || 'CLI default'}\nSubagent model: ${models.subagentModel || 'CLI default'}`;
                item.iconPath = new vscode.ThemeIcon('account');
                item.command = { command: 'wolfbook.agentAccounts.manage', title: 'Manage account', arguments: [node] };
                item.contextValue = 'wolfbookAgentAccount';
            } else item.iconPath = new vscode.ThemeIcon('repo');
            return item;
        },
        async getChildren(node) {
            return node ? (node.provider ? [] : Object.keys(PROVIDERS).map(provider => ({ repo: node.repo, provider })))
                : (await workspaceRoots()).map(repo => ({ repo }));
        },
    };
    const guarded = fn => async (...args) => {
        try {
            if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before managing CLI accounts.');
            return await fn(...args);
        } catch (error) { vscode.window.showErrorMessage(`Wolfbook accounts: ${error.message}`); }
    };
    context.subscriptions.push(changed,
        profileStore.watch(refresh),
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
    accountItem.tooltip = 'Manage Claude Code and Codex accounts for this workspace folder';
    accountItem.command = 'wolfbook.agentAccounts.manage';
    accountItem.accessibilityInformation = { label: 'Manage Wolfbook CLI accounts', role: 'button' };
    context.subscriptions.push(accountItem);
    accountItem.show();
    if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('claudeCode.claudeProcessWrapper')) refresh();
    }));
    require('./codex-history').register(context, vscode, () => resolveExecutable(vscode, 'codex'));
    refresh();
}

module.exports = { register, repositoryKey, profileDirectory, launchOptions, resolveExecutable };
