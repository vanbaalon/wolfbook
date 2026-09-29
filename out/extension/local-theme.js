'use strict';

const COLORS = [
    ['Light green', '#75A86A'], ['Blue', '#6B9CCD'], ['Lavender', '#A18BC7'],
    ['Pink', '#D68CA9'], ['Peach', '#D6A075'], ['Aqua', '#65ABA5'], ['Neutral grey', '#939393'],
];
const KEYS = [
    'editor.background', 'editorGroup.emptyBackground', 'sideBar.background', 'activityBar.background',
    'panel.background', 'terminal.background', 'titleBar.activeBackground', 'titleBar.inactiveBackground',
    'editorGroupHeader.tabsBackground', 'tab.activeBackground', 'tab.inactiveBackground',
];
function mix(hex, base, amount) {
    const rgb = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
    const a = rgb(hex), b = rgb(base);
    return '#' + a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount)).toString(16).padStart(2, '0')).join('');
}
function palette(accent, dark) {
    if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('Use a six-digit hex colour such as #75A86A.');
    const base = dark ? '#181818' : '#FFFFFF';
    const main = mix(accent, base, dark ? 0.16 : 0.10);
    const side = mix(accent, base, dark ? 0.23 : 0.18);
    const bar = mix(accent, base, dark ? 0.30 : 0.26);
    return Object.fromEntries(KEYS.map(key => [key,
        ['activityBar.background', 'titleBar.activeBackground'].includes(key) ? bar
            : ['sideBar.background', 'titleBar.inactiveBackground', 'editorGroupHeader.tabsBackground', 'tab.inactiveBackground'].includes(key) ? side : main]));
}
async function show(vscode = require('vscode')) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return vscode.window.showInformationMessage('Open a workspace folder to choose a local theme.');
    const workbench = vscode.workspace.getConfiguration('workbench');
    const current = workbench.get('colorCustomizations', {})['editor.background'];
    const dark = [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);
    const selected = await vscode.window.showQuickPick([
        ...COLORS.map(([label, value]) => ({ label, value, description: palette(value, dark)['editor.background'] === current ? '✓ current' : '' })),
        { label: '$(edit) Custom colour…', value: 'custom' },
        { label: '$(discard) Use VS Code theme colours', value: 'reset', description: 'Remove this window’s local colour overrides' },
    ], { title: `Local theme — ${folder.name || require('path').basename(folder.uri.fsPath)}`,
        placeHolder: 'Window colours for this workspace; notebook backgrounds stay independent', ignoreFocusOut: true });
    if (!selected) return;
    let accent = selected.value;
    if (accent === 'custom') {
        accent = await vscode.window.showInputBox({ title: 'Local theme — custom colour',
            prompt: 'Enter an accent colour. A subtle tint will be made for your current light or dark theme.',
            placeHolder: '#75A86A', ignoreFocusOut: true,
            validateInput: value => /^#[0-9a-f]{6}$/i.test(value.trim()) ? undefined : 'Use #RRGGBB, for example #75A86A.' });
        if (accent === undefined) return;
        accent = accent.trim();
    }
    // Merge only this workspace's overrides, never materialise inherited global
    // settings here. The notebook and other extensions own their separate keys.
    const updated = { ...(workbench.inspect('colorCustomizations')?.workspaceValue || {}) };
    if (accent === 'reset') KEYS.forEach(key => delete updated[key]);
    else Object.assign(updated, palette(accent, dark));
    await workbench.update('colorCustomizations', Object.keys(updated).length ? updated : undefined,
        vscode.ConfigurationTarget.Workspace);
}
module.exports = { show, palette, KEYS };
