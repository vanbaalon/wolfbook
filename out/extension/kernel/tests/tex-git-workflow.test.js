'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    GitWorkflow, summarizeLatexChanges, sectionHeadings, equationBlocks,
    parseOverleafConnection, isOverleafUrl,
} = require('../../tex/gitWorkflow');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('section titles are read across lines and stripped for a human commit message', () => {
    const hs = sectionHeadings([
        '\\section{Introduction}',
        '\\subsection{A \\texorpdfstring{$J=1$}{J=1}',
        'example}',
    ].join('\n'));
    assert.deepStrictEqual(hs.map(x => x.title), ['Introduction', 'A J=1 example']);
});

test('display environments, brackets and dollar displays are counted', () => {
    const blocks = equationBlocks([
        '\\begin{equation}a=1\\end{equation}',
        '\\[b=2\\]',
        '$$c=3$$',
        '$d=4$',
    ].join('\n'));
    assert.strictEqual(blocks.length, 3, 'inline maths is not called an added equation');
});

test('the commit summary names changed sections and added/removed equations', () => {
    const oldText = [
        '\\section{Introduction}', 'Old prose.',
        '\\begin{equation}', 'a=1', '\\end{equation}',
        '\\section{Results}', 'Old result.',
    ].join('\n');
    const newText = [
        '\\section{Introduction}', 'New prose.',
        '\\begin{equation}', 'a=1', '\\end{equation}',
        '\\section{Results}', 'New result.', '\\[b=2\\]',
    ].join('\n');
    const summary = summarizeLatexChanges([{
        path: 'paper.tex', oldText, newText,
        diff: '@@ -2 +2 @@\n@@ -7 +7,2 @@\n',
    }], 2);
    assert.deepStrictEqual(summary.sections, ['Introduction', 'Results']);
    assert.deepStrictEqual(summary.equations, { added: 1, removed: 0 });
    assert.ok(/Introduction, Results/.test(summary.subject), summary.subject);
    assert.ok(/Equations: 1 added, 0 removed/.test(summary.body), summary.body);
    assert.ok(/Files: 2 changed/.test(summary.body), summary.body);
});

test('an Overleaf command is parsed without leaving its token in the remote URL', () => {
    const got = parseOverleafConnection(
        'git pull https://git:SECRET_TOKEN@git.overleaf.com/abc123 master');
    assert.strictEqual(got.url, 'https://git@git.overleaf.com/abc123');
    assert.strictEqual(got.token, 'SECRET_TOKEN');
    assert.strictEqual(got.branch, 'master');
    assert.ok(isOverleafUrl(got.url));
    assert.ok(!got.url.includes('SECRET_TOKEN'));

    const browser = parseOverleafConnection('https://www.overleaf.com/project/xyz789');
    assert.strictEqual(browser.url, 'https://git@git.overleaf.com/xyz789');
});

test('first commit stores the local/push choice and commits the generated message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-git-test-'));
    const file = path.join(root, 'paper.tex');
    fs.writeFileSync(file, '\\section{Results}\nNew.\n\\[x=1\\]\n');
    const calls = [];
    const run = async (_cwd, args) => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') return ok(root + '\n');
        if (key === 'config --get user.name') return ok('Ada\n');
        if (key === 'config --get user.email') return ok('ada@example.test\n');
        if (key === 'status --porcelain=v1 -z') return ok(' M paper.tex\0');
        if (key === 'add -A -- .') return ok();
        if (key === 'diff --cached --name-only -z --diff-filter=ACMRD') return ok('paper.tex\0');
        if (key === 'show HEAD:paper.tex') return ok('\\section{Results}\nOld.\n');
        if (key === 'diff --cached --unified=0 -- paper.tex') return ok('@@ -2 +2,2 @@\n');
        if (args[0] === 'commit') return ok('[main abc123] done\n');
        if (key === 'rev-parse --short HEAD') return ok('abc123\n');
        throw new Error(`unexpected git call: ${key}`);
    };
    const memory = new Map();
    const notices = [];
    const vscode = fakeVscode(root, {
        showQuickPick: async items => items[0], // local commit; explicit push
        showInputBox: async opts => opts.value,
        showInformationMessage: async message => { notices.push(message); return undefined; },
    });
    const context = { workspaceState: {
        get: key => memory.get(key), update: async (key, value) => memory.set(key, value),
    } };
    try {
        const flow = new GitWorkflow(vscode, context, { exec: run });
        assert.strictEqual(await flow.commit(file), true);
        assert.strictEqual(memory.get(`wolfbook.tex.gitPushMode:${root}`), 'separate');
        const commit = calls.find(a => a[0] === 'commit');
        assert.ok(commit, 'git commit ran');
        assert.ok(/Results/.test(commit[2]), commit.join(' '));
        assert.ok(/Equations: 1 added, 0 removed/.test(commit[4]), commit[4]);
        assert.ok(!calls.some(a => a[0] === 'push'), 'local mode does not push implicitly');
        assert.ok(notices.some(x => /Committed abc123/.test(x)), notices.join('\n'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit push offers to configure a missing remote for this repository', async () => {
    const root = '/paper'; const calls = [];
    const run = async (_cwd, args) => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') return ok(root + '\n');
        if (key === 'branch --show-current') return ok('main\n');
        if (key.includes('@{u}')) return bad('no upstream');
        if (key === 'remote') return ok('');
        if (key.startsWith('remote add origin ')) return ok();
        if (key === 'remote get-url origin') return ok('git@example.test:me/paper.git\n');
        if (key === 'ls-remote --heads origin refs/heads/main') return ok('');
        if (key === 'push --set-upstream origin main') return ok();
        throw new Error(`unexpected git call: ${key}`);
    };
    const vscode = fakeVscode(root, {
        showInformationMessage: async (_message, action) => action,
        showInputBox: async () => 'git@example.test:me/paper.git',
    });
    const flow = new GitWorkflow(vscode, { workspaceState: null }, { exec: run });
    assert.strictEqual(await flow.push('/paper/paper.tex'), true);
    assert.ok(calls.some(a => a.join(' ') ===
        'remote add origin git@example.test:me/paper.git'));
    assert.ok(calls.some(a => a.join(' ') === 'push --set-upstream origin main'));
});

test('push fetches and three-way merges remote changes before publishing', async () => {
    const root = '/paper'; const calls = []; const notices = [];
    const run = async (_cwd, args) => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') return ok(root + '\n');
        if (key === 'branch --show-current') return ok('main\n');
        if (key.includes('@{u}')) return ok('origin/main\n');
        if (key === 'remote get-url origin') return ok('https://github.com/me/paper.git\n');
        if (key === 'ls-remote --heads origin refs/heads/main') return ok('abc refs/heads/main\n');
        if (key === 'fetch --no-tags origin refs/heads/main') return ok();
        if (key === 'merge-base --is-ancestor FETCH_HEAD HEAD') return bad();
        if (key === 'merge --no-edit --autostash FETCH_HEAD') return ok('Merge made by ort.\n');
        if (key === 'push') return ok();
        throw new Error(`unexpected git call: ${key}`);
    };
    const vscode = fakeVscode(root, {
        showInformationMessage: async message => { notices.push(message); },
    });
    const flow = new GitWorkflow(vscode, { workspaceState: null }, { exec: run });
    assert.strictEqual(await flow.push('/paper/paper.tex'), true);
    const keys = calls.map(x => x.join(' '));
    assert.ok(keys.indexOf('fetch --no-tags origin refs/heads/main') <
        keys.indexOf('merge --no-edit --autostash FETCH_HEAD'));
    assert.ok(keys.indexOf('merge --no-edit --autostash FETCH_HEAD') < keys.indexOf('push'));
    assert.ok(notices.some(x => /Merged new changes/.test(x)));
});

test('a conflicting remote merge keeps clean hunks and opens Source Control', async () => {
    const root = '/paper'; const commands = []; let warned = '';
    const run = async (_cwd, args) => {
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') return ok(root + '\n');
        if (key === 'branch --show-current') return ok('main\n');
        if (key.includes('@{u}')) return ok('origin/main\n');
        if (key === 'remote get-url origin') return ok('https://github.com/me/paper.git\n');
        if (key === 'ls-remote --heads origin refs/heads/main') return ok('abc refs/heads/main\n');
        if (key === 'fetch --no-tags origin refs/heads/main') return ok();
        if (key === 'merge-base --is-ancestor FETCH_HEAD HEAD') return bad();
        if (key === 'merge --no-edit --autostash FETCH_HEAD') return bad('CONFLICT');
        if (key === 'diff --name-only --diff-filter=U -z') return ok('paper.tex\0');
        throw new Error(`unexpected git call: ${key}`);
    };
    const vscode = fakeVscode(root, {
        showWarningMessage: async message => { warned = message; return 'Open Source Control'; },
    });
    vscode.commands = { executeCommand: async id => commands.push(id) };
    const flow = new GitWorkflow(vscode, { workspaceState: null }, { exec: run });
    assert.strictEqual(await flow.push('/paper/paper.tex'), false);
    assert.ok(/merged the remote changes it could/i.test(warned));
    assert.deepStrictEqual(commands, ['workbench.view.scm']);
});

test('guided Overleaf setup stores the token as a secret and sanitizes the remote', async () => {
    const root = '/paper'; const calls = []; const stored = new Map();
    const run = async (_cwd, args) => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') return ok(root + '\n');
        if (key === 'remote get-url overleaf') return bad('missing');
        if (key === 'remote') return ok('');
        if (key === 'remote add overleaf https://git@git.overleaf.com/project123') return ok();
        if (key.startsWith('config --local wolfbook.overleaf')) return ok();
        throw new Error(`unexpected git call: ${key}`);
    };
    const answers = ['git pull https://git:TOP_SECRET@git.overleaf.com/project123 master'];
    const vscode = fakeVscode(root, {
        showQuickPick: async items => items[0],
        showInputBox: async () => answers.shift(),
        showInformationMessage: async () => undefined,
    });
    const context = {
        workspaceState: null,
        secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value) },
    };
    const flow = new GitWorkflow(vscode, context, { exec: run });
    assert.strictEqual(await flow.configureOverleaf('/paper/paper.tex'), true);
    assert.ok(calls.some(a => a.join(' ') ===
        'remote add overleaf https://git@git.overleaf.com/project123'));
    assert.ok(!JSON.stringify(calls).includes('TOP_SECRET'), 'the token never enters a Git argument');
    assert.strictEqual(stored.get(`wolfbook.tex.overleafToken:${root}:overleaf`), 'TOP_SECRET');
});

test('an existing Overleaf Git remote is reported and can be removed safely', async () => {
    const root = '/paper'; const calls = []; const notices = []; const deleted = [];
    const run = async (_cwd, args) => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') return ok(root + '\n');
        if (key === 'remote get-url overleaf') return bad('missing');
        if (key === 'remote') return ok('origin\ncloud\n');
        if (key === 'remote get-url origin') return ok('git@example.test:me/paper.git\n');
        if (key === 'remote get-url cloud') return ok('https://git:OLD_TOKEN@git.overleaf.com/project123\n');
        if (key === 'remote remove cloud') return ok();
        if (key.startsWith('config --local --unset-all wolfbook.overleaf')) return ok();
        throw new Error(`unexpected git call: ${key}`);
    };
    const vscode = fakeVscode(root, {
        showQuickPick: async () => { throw new Error('setup must not be shown'); },
        showInputBox: async () => { throw new Error('setup must not be shown'); },
        showInformationMessage: async (message, options, ...actions) => {
            notices.push({ message, options, actions });
            return /configured successfully/.test(message) ? 'Delete current sync' : undefined;
        },
        showWarningMessage: async (_message, _options, action) => action,
    });
    const flow = new GitWorkflow(vscode, {
        workspaceState: null,
        secrets: { delete: async key => deleted.push(key) },
    }, { exec: run });
    assert.strictEqual(await flow.configureOverleaf('/paper/paper.tex'), true);
    const status = notices.find(x => /configured successfully/.test(x.message));
    assert.ok(status, 'the existing Git configuration is acknowledged');
    assert.ok(status.options.detail.includes('Git remote: cloud'));
    assert.ok(!status.options.detail.includes('OLD_TOKEN'), 'credentials are never shown');
    assert.ok(status.actions.includes('Delete current sync'));
    assert.ok(calls.some(a => a.join(' ') === 'remote remove cloud'));
    assert.deepStrictEqual(deleted, [`wolfbook.tex.overleafToken:${root}:cloud`]);
    assert.ok(notices.some(x => /local files and Git history were kept/.test(x.message)));
});

test('Overleaf push maps any local branch to master and authenticates without URL credentials', async () => {
    const root = '/paper'; const calls = [];
    const run = async (_cwd, args, opts = {}) => {
        calls.push({ args, env: opts.env || {} });
        const key = args.join(' ');
        if (key === 'branch --show-current') return ok('main\n');
        if (key.includes('@{u}')) return bad();
        if (key === 'remote get-url overleaf') return ok('https://git@git.overleaf.com/project123\n');
        if (key === 'ls-remote --heads overleaf refs/heads/master') return ok('abc refs/heads/master\n');
        if (key === 'fetch --no-tags overleaf refs/heads/master') return ok();
        if (key === 'merge-base --is-ancestor FETCH_HEAD HEAD') return ok();
        if (key === 'push --set-upstream overleaf HEAD:master') return ok();
        throw new Error(`unexpected git call: ${key}`);
    };
    const context = {
        workspaceState: null,
        secrets: {
            get: async () => 'TOKEN_FROM_SECRET_STORAGE',
            store: async () => {},
        },
    };
    const flow = new GitWorkflow(fakeVscode(root), context, { exec: run });
    try {
        assert.strictEqual(await flow.push('/paper/paper.tex', {
            repo: root, remote: 'overleaf', remoteBranch: 'master',
        }), true);
        assert.ok(calls.some(x => x.args.join(' ') ===
            'push --set-upstream overleaf HEAD:master'));
        const network = calls.filter(x => ['ls-remote', 'fetch', 'push'].includes(x.args[0]));
        assert.ok(network.every(x => x.env.WOLFBOOK_GIT_TOKEN === 'TOKEN_FROM_SECRET_STORAGE'));
        assert.ok(network.every(x => !x.args.join(' ').includes('TOKEN_FROM_SECRET_STORAGE')));
    } finally {
        if (flow._askpassDir) fs.rmSync(flow._askpassDir, { recursive: true, force: true });
    }
});

test('a new folder is offered local repository and author configuration', async () => {
    const root = '/new-paper'; const calls = []; let topChecks = 0;
    const run = async (_cwd, args) => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'rev-parse --show-toplevel') {
            topChecks++;
            return topChecks === 1 ? bad('not a git repository') : ok(root + '\n');
        }
        if (key === 'init') return ok('Initialized empty Git repository');
        if (key === 'config --get user.name' || key === 'config --get user.email') return bad();
        if (key.startsWith('config --local user.')) return ok();
        if (key === 'status --porcelain=v1 -z') return ok('');
        throw new Error(`unexpected git call: ${key}`);
    };
    const answers = ['Ada Lovelace', 'ada@example.test'];
    const vscode = fakeVscode(root, {
        showInformationMessage: async (_message, action) => action,
        showInputBox: async () => answers.shift(),
        showQuickPick: async items => items[0],
    });
    const memory = new Map();
    const flow = new GitWorkflow(vscode, { workspaceState: {
        get: key => memory.get(key), update: async (key, value) => memory.set(key, value),
    } }, { exec: run });
    assert.strictEqual(await flow.commit('/new-paper/paper.tex'), false, 'nothing existed to commit');
    assert.ok(calls.some(a => a.join(' ') === 'init'));
    assert.ok(calls.some(a => a.join(' ') === 'config --local user.name Ada Lovelace'));
    assert.ok(calls.some(a => a.join(' ') === 'config --local user.email ada@example.test'));
});

test('the commands and default editor shortcuts are shipped', () => {
    const ext = path.resolve(__dirname, '..', '..', '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
    const ids = new Set(pkg.contributes.commands.map(x => x.command));
    assert.ok(ids.has('wolfbook.tex.commitChanges'));
    assert.ok(ids.has('wolfbook.tex.pushChanges'));
    assert.ok(ids.has('wolfbook.tex.chooseCommitPushMode'));
    assert.ok(ids.has('wolfbook.tex.configureOverleaf'));
    const keys = pkg.contributes.keybindings;
    assert.ok(keys.some(x => x.command === 'wolfbook.tex.commitChanges' && x.key === 'ctrl+alt+enter'));
    assert.ok(keys.some(x => x.command === 'wolfbook.tex.pushChanges' && x.key === 'ctrl+shift+alt+enter'));
    const client = fs.readFileSync(path.join(ext, 'out/client/tex-viewer.js'), 'utf8');
    assert.ok(/ev\.shiftKey \? 'gitPush' : 'gitCommit'/.test(client),
        'the same shortcuts work while the mini-editor owns focus');
    const overleaf = pkg.contributes.commands.find(x => x.command === 'wolfbook.tex.configureOverleaf');
    assert.ok(/Overleaf Git Sync/.test(overleaf.title), 'the command names Git, not GitHub integration');
    assert.ok(overleaf.icon && /overleaf/.test(overleaf.icon.light), 'the editor action has its leaf icon');
    assert.ok(fs.existsSync(path.join(ext, overleaf.icon.light)), 'the light leaf icon is shipped');
    assert.ok(fs.existsSync(path.join(ext, overleaf.icon.dark)), 'the dark leaf icon is shipped');
    assert.ok(pkg.contributes.menus['editor/title'].some(x =>
        x.command === 'wolfbook.tex.configureOverleaf' && /\.tex/.test(x.when)));
});

function ok(stdout = '') { return { code: 0, stdout, stderr: '' }; }
function bad(stderr = '') { return { code: 1, stdout: '', stderr }; }

function fakeVscode(root, windowOverrides = {}) {
    return {
        Uri: { file: fsPath => ({ fsPath }), parse: value => ({ value }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: root } }], textDocuments: [],
            getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
            getConfiguration: () => ({ get: () => undefined }),
        },
        window: {
            showQuickPick: async items => items[0],
            showInputBox: async opts => opts.value,
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showErrorMessage: async message => { throw new Error(message); },
            ...windowOverrides,
        },
        env: { openExternal: async () => true },
        commands: { executeCommand: async () => undefined },
    };
}

(async () => {
    console.log('WPaper Git workflow\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`  ok   ${name}`); }
        catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.stack || e}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
