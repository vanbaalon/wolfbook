'use strict';
// ---------------------------------------------------------------------------
// Claude Science connector: the VS Code side (command, activation pass).
// The file-level work (plan, local-mcp.json, config.toml) is in server.js.
//
// Activation never widens Claude Science's sandbox. It only (a) keeps an
// existing Wolfbook-written connector current — the bridge copy and the entry —
// and (b) offers, at most weekly, to finish the setup. Adding the sandbox
// grants to config.toml happens only in the command, after a modal consent.
// ---------------------------------------------------------------------------

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const OFFER_KEY = 'wolfbook.claudeScience.offer';   // { dismissed, lastShown }
const OFFER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

function _server() { return require('./server'); }

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ resolveNodeBinary: () => string, checkNode: () => Promise<string|null>, mcpEnabled: boolean }} deps
 */
function register(context, deps) {
    const bridgePath = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.configureClaudeScience',
        () => configure(context, deps, bridgePath)));
    if (deps.mcpEnabled) {
        const t = setTimeout(() => activationPass(context, deps, bridgePath).catch(e =>
            console.warn('[Wolfbook MCP] Claude Science activation pass failed:', e.message)), 5000);
        context.subscriptions.push({ dispose: () => clearTimeout(t) });
    }
}

async function activationPass(context, deps, bridgePath) {
    const s = _server();
    if (!s.claudeScienceInstalled()) return;
    const plan = s.claudeSciencePlan(deps.resolveNodeBinary());
    if (!plan.socketPath) return;
    const entry = s.claudeScienceEntryState(plan);
    if (entry.present && !entry.managed) return;          // the user's own entry: hands off
    if (entry.present) {
        try { s.installClaudeScienceBridge(bridgePath, plan); } catch (_) {}
        if (!entry.current) s.writeClaudeScienceConfig(plan);
    }
    if (entry.present && s.claudeScienceSandboxState(plan).ok) return;

    const st = context.globalState.get(OFFER_KEY) || {};
    if (st.dismissed || (st.lastShown && Date.now() - st.lastShown < OFFER_EVERY_MS)) return;
    await context.globalState.update(OFFER_KEY, { ...st, lastShown: Date.now() });
    const pick = await vscode.window.showInformationMessage(
        entry.present
            ? 'Wolfbook is registered in Claude Science, but Claude Science\'s sandbox still blocks it. Finish the setup?'
            : 'Claude Science is installed. Connect Wolfbook so Claude Science can use your notebooks and Wolfram kernel?',
        'Connect…', 'Not Now', 'Don\'t Ask Again');
    if (pick === 'Connect…') vscode.commands.executeCommand('wolfbook.configureClaudeScience');
    else if (pick === 'Don\'t Ask Again') await context.globalState.update(OFFER_KEY, { ...st, dismissed: true });
}

async function configure(context, deps, bridgePath) {
    if (!deps.mcpEnabled) {
        vscode.window.showWarningMessage('Wolfbook\'s MCP server is turned off (wolfbook.mcpEnabled). Turn it on and reload the window first.');
        return;
    }
    const s = _server();
    if (!s.claudeScienceInstalled()) {
        vscode.window.showWarningMessage('Claude Science does not appear to be installed (~/.claude-science not found). Install and start it once, then try again.');
        return;
    }
    const nodeBin = await deps.checkNode();
    if (!nodeBin) return;
    const plan = s.claudeSciencePlan(nodeBin);
    if (!plan.socketPath) {
        vscode.window.showErrorMessage('Claude Science needs Wolfbook\'s Unix socket, which is not available on this platform.');
        return;
    }

    const sandbox = s.claudeScienceSandboxState(plan);
    if (!sandbox.ok) {
        const lines = [];
        if (sandbox.missingReads.length) lines.push(`read (never write): ${sandbox.missingReads.join(', ')}`);
        if (sandbox.missingSockets.length) lines.push(`connect to Wolfbook's private socket in ${sandbox.missingSockets.join(', ')}`);
        const ok = await vscode.window.showWarningMessage('Let Wolfbook through Claude Science\'s sandbox?', {
            modal: true,
            detail: 'Claude Science runs every connector in a sandbox. To start Wolfbook, that sandbox must be allowed to:\n\n• ' +
                lines.join('\n• ') +
                `\n\nWolfbook adds exactly these entries to ${plan.tomlPath} and changes nothing else. ` +
                'Claude Science must restart before they take effect.',
        }, 'Allow and Connect');
        if (ok !== 'Allow and Connect') return;
    }

    try { s.installClaudeScienceBridge(bridgePath, plan); }
    catch (e) { vscode.window.showErrorMessage(`Could not copy the Wolfbook bridge to ${plan.bridge}: ${e.message}`); return; }
    const w = s.writeClaudeScienceConfig(plan);
    if (!w.updated) {
        vscode.window.showErrorMessage(`Could not update ${w.configPath}${w.error ? `: ${w.error}` : ''}. If it is not valid JSON, fix or remove it and try again.`);
        return;
    }
    if (!sandbox.ok) {
        const g = s.grantClaudeScienceSandbox(plan);
        if (!g.ok) {
            const doc = await vscode.workspace.openTextDocument({ language: 'toml', content:
                `# Add these lines to ${plan.tomlPath}, then restart Claude Science.\n` +
                `# Wolfbook did not edit the file itself: ${g.error}\n\n${s.claudeScienceTomlSnippet(plan)}` });
            await vscode.window.showTextDocument(doc);
            vscode.window.showWarningMessage(`The connector is registered, but Wolfbook could not safely edit ${path.basename(plan.tomlPath)}. Paste the lines it opened into that file, then restart Claude Science.`);
            return;
        }
    }

    const restartNeeded = !sandbox.ok;
    const actions = restartNeeded ? ['Restart Claude Science', 'Open config.toml'] : ['Open Connector File'];
    const pick = await vscode.window.showInformationMessage(restartNeeded
        ? 'Claude Science configured ✓ Restart Claude Science so its sandbox picks up the change, then start a new conversation.'
        : 'Claude Science configured ✓ Start a new conversation to use Wolfbook.', ...actions);
    if (pick === 'Restart Claude Science') await restartClaudeScience();
    else if (pick === 'Open config.toml') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(plan.tomlPath));
    else if (pick === 'Open Connector File') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(plan.configPath));
}

async function restartClaudeScience() {
    const cli = path.join(os.homedir(), '.claude-science', 'bin', process.platform === 'win32' ? 'claude-science.exe' : 'claude-science');
    const ok = await vscode.window.showWarningMessage('Restart Claude Science now?', {
        modal: true, detail: 'Conversations that are still running are cut off and will show as failed.',
    }, 'Restart');
    if (ok !== 'Restart') return;
    const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 30000 }, err => resolve(err)));
    const stopErr = await run(cli, ['stop']);
    if (stopErr) {
        vscode.window.showErrorMessage(`Could not stop Claude Science (${stopErr.message}). Quit and reopen it yourself.`);
        return;
    }
    // Reopen the way the user normally does: the app on macOS, the daemon elsewhere.
    const startErr = process.platform === 'darwin'
        ? await run('open', ['-b', 'com.anthropic.operon'])
        : await run(cli, ['serve', '--detached']);
    if (startErr) vscode.window.showWarningMessage(`Claude Science stopped, but reopening it failed (${startErr.message}). Start it yourself.`);
    else vscode.window.showInformationMessage('Claude Science restarted. Start a new conversation to use Wolfbook.');
}

module.exports = { register };
