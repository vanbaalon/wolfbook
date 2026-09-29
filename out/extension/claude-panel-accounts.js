'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWrite(file, text, mode = 0o600) {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temp, text, { mode });
        fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}

function createBridge(context, vscode, resolveNode) {
    const directory = path.join(context.globalStorageUri.fsPath, 'claude-panel');
    const launcher = path.join(directory, 'launch.sh');
    const routeFile = path.join(directory, `host-${process.pid}.json`);
    const configFile = path.join(directory, 'config.json');
    // The native Claude extension reads local transcripts in this extension
    // host, outside our subprocess wrapper. Keep its history root aligned with
    // the route. Each VS Code window has its own host process/environment.
    const originalConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    let appliedConfigDirectory;
    let ownsConfigDirectory = false;
    function restoreConfigDirectory() {
        if (ownsConfigDirectory && process.env.CLAUDE_CONFIG_DIR === appliedConfigDirectory) {
            if (originalConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = originalConfigDirectory;
        }
        ownsConfigDirectory = false;
    }
    function syncConfigDirectory(env) {
        if (!env.CLAUDE_CONFIG_DIR) { restoreConfigDirectory(); return; }
        process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
        appliedConfigDirectory = env.CLAUDE_CONFIG_DIR;
        ownsConfigDirectory = true;
    }
    const supported = () => process.platform !== 'win32' && !!vscode.extensions.getExtension('anthropic.claude-code');
    const clear = () => {
        restoreConfigDirectory();
        try { fs.unlinkSync(routeFile); } catch (_) {}
    };

    async function sync(root, env, enabled) {
        if (!supported() || !vscode.workspace.isTrusted) return false;
        const setting = vscode.workspace.getConfiguration('claudeCode');
        const previous = setting.get('claudeProcessWrapper', '');
        // Default windows still register an explicit pass-through route once
        // the shared launcher is installed by another window.
        if (!enabled && previous !== launcher) return false;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicWrite(routeFile, JSON.stringify({ pid: process.pid, root, env }));
        const node = resolveNode();
        if (!path.isAbsolute(node)) throw new Error('A standalone Node executable is required for Claude panel accounts.');
        const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
        atomicWrite(path.join(directory, 'launcher.js'), fs.readFileSync(path.join(__dirname, 'claude-panel-launcher.js'), 'utf8'));
        atomicWrite(launcher, `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(directory, 'launcher.js'))} "$@"\n`, 0o700);
        if (previous !== launcher || !fs.existsSync(configFile)) {
            atomicWrite(configFile, JSON.stringify({ previousWrapper: previous === launcher ? '' : previous }));
        }
        syncConfigDirectory(env);
        if (previous !== launcher) await setting.update('claudeProcessWrapper', launcher, vscode.ConfigurationTarget.Global);
        return true;
    }

    context.subscriptions.push({ dispose: clear });
    return { supported, sync, clear };
}

module.exports = { createBridge, atomicWrite };
