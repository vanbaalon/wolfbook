'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function canonical(directory) {
    let value = path.resolve(directory);
    try { value = fs.realpathSync(value); } catch (_) { /* Removed work directories still have history. */ }
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

function inFolder(directory, root) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return false;
    const relative = path.relative(canonical(root), canonical(directory));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Use Codex's own history API: newer sessions can live in its database rather
// than rollout files. Never read credentials or modify/move history ourselves.
function listFolderThreads(executable, root, options = {}) {
    return new Promise((resolve, reject) => {
        const child = (options.spawn || spawn)(executable, ['app-server'], {
            cwd: root, env: options.env || process.env, windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '', finished = false, nextId = 1, expectedId, phase = 'initialize';
        const threads = new Map(), cursors = new Set();
        const timer = setTimeout(() => finish(new Error('Codex history took too long to load. Try again.')), options.timeoutMs || 30000);
        function finish(error) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            child.stdin.end();
            child.kill();
            if (error) reject(error);
            else resolve([...threads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
        }
        function request(method, params) {
            expectedId = nextId++;
            child.stdin.write(JSON.stringify({ id: expectedId, method, params }) + '\n');
        }
        function page(cursor = null) {
            phase = 'list';
            request('thread/list', { limit: 100, cursor, sortKey: 'updated_at', archived: false,
                modelProviders: [], sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] });
        }
        child.on('error', error => finish(error));
        child.on('exit', code => finish(new Error(`Codex history process exited before completing (${code}).`)));
        child.stdin.on('error', error => finish(error));
        child.stderr.resume(); // Diagnostic output must not enter the JSON protocol or expose user data.
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            if (finished) return;
            buffer += chunk;
            if (buffer.length > 16 * 1024 * 1024) return finish(new Error('Codex history response was too large.'));
            let newline;
            while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                let message;
                try { message = JSON.parse(line); } catch (_) { continue; }
                if (message.id !== expectedId) continue;
                if (message.error) return finish(new Error(message.error.message || 'Codex could not read its history.'));
                if (phase === 'initialize') {
                    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
                    page();
                } else {
                    if (!Array.isArray(message.result?.data)) return finish(new Error('Unexpected Codex history response.'));
                    for (const thread of message.result.data) {
                        if (/^[a-f0-9-]{36}$/i.test(thread.id) && inFolder(thread.cwd, root)) threads.set(thread.id, thread);
                    }
                    const cursor = message.result.nextCursor;
                    if (!cursor) return finish();
                    if (cursors.has(cursor)) return finish(new Error('Codex history returned a repeated page.'));
                    cursors.add(cursor); page(cursor);
                }
            }
        });
        request('initialize', { clientInfo: { name: 'wolfbook_history', title: 'Wolfbook folder history', version: '1.0.0' },
            capabilities: { experimentalApi: true } });
    });
}

function register(context, vscode, resolveExecutable, listThreads = listFolderThreads) {
    const command = 'wolfbook.codexHistory';
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
        try {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (root?.scheme !== 'file') return vscode.window.showInformationMessage('Open a workspace folder to browse Codex history.');
            if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before browsing Codex history.');
            if (!vscode.extensions.getExtension('openai.chatgpt')) throw new Error('Install the Codex extension to open its sessions.');
            const items = listThreads(resolveExecutable(), root.fsPath).then(threads => threads.map(thread => ({
                label: String(thread.name || thread.title || thread.preview || 'Untitled session').replace(/[\r\n\t]+/g, ' ').slice(0, 180),
                description: thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString() : '',
                detail: path.relative(root.fsPath, thread.cwd) || '(main folder)',
                id: thread.id,
            })));
            const chosen = await vscode.window.showQuickPick(items, {
                title: `Codex history — ${path.basename(root.fsPath)}`,
                placeHolder: 'Sessions in this main folder and its subfolders', matchOnDetail: true,
            });
            if (chosen) {
                const opened = await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/${chosen.id}`));
                if (!opened) throw new Error('VS Code could not open the selected Codex session.');
            }
        } catch (error) { vscode.window.showErrorMessage(`Wolfbook Codex history: ${error.message}`); }
    }));
    const item = vscode.window.createStatusBarItem('wolfbook-codex-history', vscode.StatusBarAlignment.Right, 96);
    item.name = 'Codex Folder History';
    item.text = '$(history)';
    item.tooltip = 'Codex sessions in this workspace folder';
    item.command = command;
    item.accessibilityInformation = { label: 'Open Codex history for this workspace folder', role: 'button' };
    context.subscriptions.push(item);
    item.show();
}

module.exports = { register, listFolderThreads, inFolder };
