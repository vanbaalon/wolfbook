"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerNotebookSettings = registerNotebookSettings;
exports.applyNotebookSettings = applyNotebookSettings;

const vscode = require("vscode");
const path   = require("path");
const fs     = require("fs");
const os     = require("os");
const configCompat = require("./config-compat");
const { devLog, LOG_CHANNELS, LOG_CHANNEL_LABELS, DEV_MODE, getLogMask, setLogMask } = require('./utils/dev-logger');

// ── Wolfbook prompt presets (~/.wolfbook/prompts/) ────────────────────────────
// Stored OUTSIDE the extension so updates never overwrite user edits.
const _WOLFBOOK_DIR  = path.join(os.homedir(), '.wolfbook');
const _PROMPTS_DIR   = path.join(_WOLFBOOK_DIR, 'prompts');
// Active preset is stored per-workspace in VS Code settings (wolfbook.activeSystemPrompt)
// so different projects can have different active prompts.
const _ACTIVE_PRESET_KEY = 'activeSystemPrompt';
const _APPEARANCE_KEY = 'notebook.appearanceByUri';
const _APPEARANCE_FIELDS = new Set(['backgroundColor', 'backgroundImagePath']);

function _ensurePromptsDir() {
    if (!fs.existsSync(_PROMPTS_DIR)) fs.mkdirSync(_PROMPTS_DIR, { recursive: true });
}

/** Always sync ~/.wolfbook/prompts/default.md from the bundled prompt.
 *  'default' is a read-only built-in that tracks the extension's bundled file.
 *  Users who want a customised prompt should create a named preset instead. */
function _ensureDefaultPrompt() {
    _ensurePromptsDir();
    const defaultPath = path.join(_PROMPTS_DIR, 'default.md');
    const srcPath = path.join(__dirname, 'tools', 'wolfbook-system-prompt.md');
    try { fs.copyFileSync(srcPath, defaultPath); } catch (_) {}
}

function _listPrompts() {
    _ensurePromptsDir();
    try {
        return fs.readdirSync(_PROMPTS_DIR)
            .filter(f => f.endsWith('.md'))
            .map(f => ({ name: f.slice(0, -3), filePath: path.join(_PROMPTS_DIR, f) }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) { return []; }
}

function _getActivePromptName() {
    // Read from workspace-scoped VS Code settings so each project can have its own preset.
    const name = vscode.workspace.getConfiguration('wolfbook').get(_ACTIVE_PRESET_KEY, '');
    if (name && fs.existsSync(path.join(_PROMPTS_DIR, name + '.md'))) return name;
    const prompts = _listPrompts();
    return prompts.length > 0 ? prompts[0].name : 'default';
}

async function _setActivePromptName(name) {
    await vscode.workspace.getConfiguration('wolfbook').update(
        _ACTIVE_PRESET_KEY, name, vscode.ConfigurationTarget.Workspace);
}

function _getActivePromptPath() {
    return path.join(_PROMPTS_DIR, _getActivePromptName() + '.md');
}

// ── Colour palette ────────────────────────────────────────────────────────────
const BACKGROUND_COLORS_LIGHT = [
    { label: "Light Cream",    value: "#FFF8F0" },
    { label: "Soft Peach",     value: "#FFE5E5" },
    { label: "Pale Yellow",    value: "#FFFACD" },
    { label: "Light Mint",     value: "#F0FFF0" },
    { label: "Powder Blue",    value: "#F0F8FF" },
    { label: "Lavender Mist",  value: "#F8F0FF" },
    { label: "Pale Pink",      value: "#FFF0F5" },
    { label: "Light Aqua",     value: "#E0FFFF" },
    { label: "Soft Lime",      value: "#F5FFED" },
    { label: "Champagne",      value: "#FAF0E6" },
    { label: "Pale Turquoise", value: "#E8F8F5" },
    { label: "Light Coral",    value: "#FFF5F0" },
];

// Neutral gray painted on notebooks that were never given a background colour
// (e.g. created by wolfbook_newNotebook). Without this, VS Code's default BLUE
// focused/selected-cell highlight leaks through — the notebook looks half-styled.
// Picking "Default (None)" explicitly still strips to the raw VS Code theme.
const DEFAULT_BG_GRAY_LIGHT = "#F3F3F3";
const DEFAULT_BG_GRAY_DARK  = "#262626";

const BACKGROUND_COLORS_DARK = [
    { label: "Dark Cream",     value: "#2A2520" },
    { label: "Dark Peach",     value: "#2E2020" },
    { label: "Dark Yellow",    value: "#2A2918" },
    { label: "Dark Mint",      value: "#1E2A1E" },
    { label: "Dark Blue",      value: "#1E2530" },
    { label: "Dark Lavender",  value: "#28202E" },
    { label: "Dark Pink",      value: "#2A2025" },
    { label: "Dark Aqua",      value: "#1C2A2A" },
    { label: "Dark Lime",      value: "#232A1E" },
    { label: "Dark Champagne", value: "#2A2518" },
    { label: "Dark Turquoise", value: "#1E2825" },
    { label: "Dark Coral",     value: "#2A2320" },
];

// Keys that applyNotebookSettings writes into workbench.colorCustomizations
const _NOTEBOOK_COLOR_KEYS = [
    'notebook.editorBackground',
    'notebook.cellEditorBackground',
    'notebook.cellBorderColor',
    'notebook.inactiveFocusedCellBorder',
    'notebook.collapsedCellBackground',
    'notebook.focusedCellBackground',
    'notebook.selectedCellBackground',
    'notebook.inactiveSelectedCellBackground',
    'notebook.cellHoverBackground',
];

/** Returns true if all notebook color keys are identical between two colorCustomizations objects. */
function _notebookColorsUnchanged(current, updated) {
    for (const key of _NOTEBOOK_COLOR_KEYS) {
        if ((current[key] || undefined) !== (updated[key] || undefined)) return false;
    }
    return true;
}

// Detect dark vs light theme
function _isDarkTheme() {
    // ColorThemeKind: Light=1, Dark=2, HighContrast=3, HighContrastLight=4
    const kind = vscode.window.activeColorTheme?.kind;
    return kind === 2 || kind === 3;
}

function _getBackgroundColors() {
    return _isDarkTheme() ? BACKGROUND_COLORS_DARK : BACKGROUND_COLORS_LIGHT;
}

// Light ↔ Dark mapping (by index) for auto-inversion on theme switch
const _LIGHT_TO_DARK = new Map();
const _DARK_TO_LIGHT = new Map();
for (let i = 0; i < BACKGROUND_COLORS_LIGHT.length; i++) {
    _LIGHT_TO_DARK.set(BACKGROUND_COLORS_LIGHT[i].value, BACKGROUND_COLORS_DARK[i].value);
    _DARK_TO_LIGHT.set(BACKGROUND_COLORS_DARK[i].value, BACKGROUND_COLORS_LIGHT[i].value);
}

/** If the saved color belongs to the "wrong" palette for the current theme, return its counterpart. */
function _autoInvertColor(hex) {
    if (!hex) return hex;
    if (_isDarkTheme() && _LIGHT_TO_DARK.has(hex)) return _LIGHT_TO_DARK.get(hex);
    if (!_isDarkTheme() && _DARK_TO_LIGHT.has(hex)) return _DARK_TO_LIGHT.get(hex);
    return hex;
}

// Keep BACKGROUND_COLORS as an alias for backward compat (exports)
const BACKGROUND_COLORS = BACKGROUND_COLORS_LIGHT;

// Render a 14×14 rounded square with the given hex fill as a base64 SVG data-URI.
// Used as QuickPickItem.iconPath so each palette entry shows its own colour swatch.
function colorSwatch(hex) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'>`
              + `<rect x='1' y='1' width='14' height='14' rx='3' fill='${hex}' `
              + `stroke='rgba(128,128,128,0.45)' stroke-width='1'/></svg>`;
    return vscode.Uri.parse(
        'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
    );
}

// ── Renderer messaging (for background-image injection into output webviews) ──
// Each output cell is rendered inside an isolated webview iframe; we broadcast
// a base64 data-URL so the renderer can set body { background-image: … }.
let _rendererMsg = null;
function getRendererMsg() {
    if (_rendererMsg) return _rendererMsg;
    try {
        _rendererMsg = vscode.notebooks.createRendererMessaging("wolfram-notebook-renderer");
        // When a new output renderer webview announces itself as ready, re-send the
        // background image for the currently active wolfram notebook so that newly
        // rendered cell outputs inherit the same background.
        _rendererMsg.onDidReceiveMessage(event => {
            if (event.message.type !== 'renderer-ready') return;
            const active = vscode.window.activeNotebookEditor;
            if (active && active.notebook.notebookType === 'extended-wolfram-notebook') {
                const settings = getNotebookSettings(active.notebook);
                if (settings.backgroundImagePath) {
                    _broadcastBgImage(settings.backgroundImagePath).catch(() => {});
                }
            }
        });
    } catch (e) {
        console.warn('[NotebookSettings] createRendererMessaging failed:', e);
    }
    return _rendererMsg;
}

// Read an image file and broadcast it as a base64 data-URL to all output renderers.
async function _broadcastBgImage(imgPath) {
    const msg = getRendererMsg();
    if (!msg || !imgPath) return;
    const data = fs.readFileSync(imgPath);
    const ext  = path.extname(imgPath).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : ext === 'png'  ? 'image/png'
               : ext === 'gif'  ? 'image/gif'
               : ext === 'webp' ? 'image/webp'
               : ext === 'svg'  ? 'image/svg+xml'
               : 'image/png';
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
    msg.postMessage({ type: 'bg-image', dataUrl });
}

// ── Settings store ────────────────────────────────────────────────────────────
const notebookSettingsStore = new Map();

function registerNotebookSettings(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.notebookSettings', async () => {
            // Short delay so toolbar-click focus returns to notebook before QuickPick opens
            await new Promise(resolve => setTimeout(resolve, 150));
            try {
                const active = vscode.window.activeNotebookEditor;
                const notebookEditors = vscode.window.visibleNotebookEditors;
                const wolframEditor =
                    (active && active.notebook && active.notebook.notebookType === 'extended-wolfram-notebook' ? active : null) ||
                    notebookEditors.find(e => e.notebook.notebookType === 'extended-wolfram-notebook');

                devLog(LOG_CHANNELS.EXTENSION, '[NotebookSettings] active=', active && active.notebook.notebookType, 'found=', !!wolframEditor);
                if (!wolframEditor) {
                    vscode.window.showErrorMessage('No Wolfram notebook is open.');
                    return;
                }

                await showSettingsUI(wolframEditor.notebook);
            } catch (err) {
                vscode.window.showErrorMessage('Notebook Settings error: ' + err.message);
                console.error('[NotebookSettings] command error:', err);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveNotebookEditor(editor => {
            if (editor && editor.notebook.notebookType === 'extended-wolfram-notebook') {
                // When multiple wolfram notebooks are visible with DIFFERENT background
                // colours, skip the global colorCustomizations update to prevent
                // the two notebooks from fighting each other and causing a blink.
                const activeColor = (getNotebookSettings(editor.notebook).backgroundColor) || null;
                const conflict = vscode.window.visibleNotebookEditors.some(e =>
                    e.notebook !== editor.notebook &&
                    e.notebook.notebookType === 'extended-wolfram-notebook' &&
                    ((getNotebookSettings(e.notebook).backgroundColor) || null) !== activeColor
                );
                if (!conflict) applyNotebookSettings(editor.notebook);
            }
        })
    );

    // Re-apply settings when theme changes (dark ↔ light) to auto-invert colours.
    // Debounced: VS Code can fire onDidChangeActiveColorTheme multiple times during
    // theme initialisation; coalescing the calls prevents the dark↔light flicker.
    // On theme change, apply the ACTIVE notebook's colour (not all visible ones in
    // sequence, which would let the last one win and cause a blink on split views).
    let _themeChangeTimer = null;
    context.subscriptions.push(
        vscode.window.onDidChangeActiveColorTheme(() => {
            if (_themeChangeTimer) clearTimeout(_themeChangeTimer);
            _themeChangeTimer = setTimeout(() => {
                _themeChangeTimer = null;
                const active = vscode.window.activeNotebookEditor;
                if (active && active.notebook.notebookType === 'extended-wolfram-notebook') {
                    applyNotebookSettings(active.notebook);
                }
            }, 300);
        })
    );

    vscode.window.visibleNotebookEditors.forEach(editor => {
        if (editor.notebook.notebookType === 'extended-wolfram-notebook') {
            applyNotebookSettings(editor.notebook);
        }
    });

    // Ensure user has a prompt preset directory with the default prompt
    _ensureDefaultPrompt();
}

// ── Settings UI ───────────────────────────────────────────────────────────────
async function showSettingsUI(notebook) {
    const cur = getNotebookSettings(notebook);
    const palette = _getBackgroundColors();
    const allPalette = [...BACKGROUND_COLORS_LIGHT, ...BACKGROUND_COLORS_DARK];
    const isCustomColor = cur.backgroundColor &&
        !allPalette.find(c => c.value === cur.backgroundColor);

    // ── Colour items ──────────────────────────────────────────────────────
    const colorItems = [
        {
            label:       '$(circle-slash) Default (None)',
            description: cur.backgroundColor === '' ? '✓ current' : 'Use VS Code theme default',
            value:       '',
        },
        ...palette.map(c => ({
            label:       c.label,
            description: c.value + (cur.backgroundColor === c.value ? '   ✓ current' : ''),
            iconPath:    colorSwatch(c.value),
            value:       c.value,
        })),
        {
            label:       '$(edit) Enter custom color…',
            description: isCustomColor ? `current: ${cur.backgroundColor}` : 'hex, rgb(), or CSS name',
            value:       '__custom__',
        },
    ];

    // ── Image items ───────────────────────────────────────────────────────
    const imageItems = [
        {
            label:       '$(file-media) Set background image…',
            description: cur.backgroundImagePath
                         ? `current: ${path.basename(cur.backgroundImagePath)}`
                         : 'PNG, JPG, GIF, WEBP, SVG  (applied to cell output area)',
            value:       '__bg_image__',
        },
    ];
    if (cur.backgroundImagePath) {
        imageItems.push({
            label:       '$(trash) Clear background image',
            description: path.basename(cur.backgroundImagePath),
            value:       '__bg_image_clear__',
        });
    }

    // ── Kernel item ───────────────────────────────────────────────────────
    const currentKernel = (configCompat.getSetting('systemKernel', 'Automatic') || 'Automatic');
    const kernelLabel   = currentKernel === 'Automatic'
        ? 'Automatic'
        : require('path').basename(require('path').dirname(require('path').dirname(currentKernel)));  // e.g. "Wolfram 3.app"
    const kernelItems = [
        {
            label:       '$(server-process) Select Kernel…',
            description: `current: ${kernelLabel}`,
            value:       '__select_kernel__',
        },
    ];

    // ── Wolfbook System Prompt presets ──────────────────────────────────────
    const _activePromptName = _getActivePromptName();
    const _allPrompts = _listPrompts();
    const promptItems = [
        ..._allPrompts.map(p => ({
            label:       (p.name === _activePromptName ? '$(check) ' : '$(circle-large-outline) ') + p.name,
            description: p.name === _activePromptName ? 'active — click to edit' : 'click to switch',
            value:       p.name === _activePromptName ? '__prompt_edit__' : '__prompt_switch__',
            _promptName: p.name,
        })),
        {
            label:       '$(add) Save current as new preset…',
            description: 'Duplicate active prompt with a new name',
            value:       '__prompt_new__',
        },
    ];
    if (_allPrompts.length > 1) {
        promptItems.push({
            label:       '$(trash) Delete "' + _activePromptName + '"',
            description: 'Remove this preset permanently',
            value:       '__prompt_delete__',
        });
    }

    // ── MCP Server toggle ────────────────────────────────────────────────
    const mcpEnabled = configCompat.getSetting('mcpEnabled', true);
    const mcpItems = [
        {
            label:       mcpEnabled ? '$(check) MCP Server Enabled' : '$(circle-slash) MCP Server Disabled',
            description: mcpEnabled ? 'Claude / MCP agents can connect' : 'MCP server is stopped',
            value:       '__mcp_toggle__',
        },
    ];

    // ── Full list with separators ─────────────────────────────────────────
    const items = [
        { label: 'Background Color', kind: vscode.QuickPickItemKind.Separator },
        ...colorItems,
        { label: 'Background Image', kind: vscode.QuickPickItemKind.Separator },
        ...imageItems,
        { label: 'Kernel', kind: vscode.QuickPickItemKind.Separator },
        ...kernelItems,
        { label: 'Copilot Instructions', kind: vscode.QuickPickItemKind.Separator },
        ...promptItems,
        { label: 'MCP Server', kind: vscode.QuickPickItemKind.Separator },
        ...mcpItems,
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        {
            label:       '$(discard) Reset all customizations',
            description: 'Remove background color and image',
            value:       '__reset__',
        },
    ];

    // ── Developer Logs section (dev machines only) ────────────────────────
    if (DEV_MODE) {
        const mask = getLogMask();
        const devLogItems = Object.entries(LOG_CHANNELS).map(([key, flag]) => {
            const on = !!(mask & flag);
            return {
                label:        (on ? '$(check) ' : '$(circle-slash) ') + LOG_CHANNEL_LABELS[key],
                description:  on ? 'logging ON' : 'logging OFF',
                value:        '__devlog_toggle__',
                _channelKey:  key,
                _channelFlag: flag,
                _channelOn:   on,
            };
        });
        items.push(
            { label: 'Developer Logs', kind: vscode.QuickPickItemKind.Separator },
            ...devLogItems,
            {
                label:       '$(check-all) Enable all log channels',
                description: 'Turn on every channel',
                value:       '__devlog_all_on__',
            },
            {
                label:       '$(close-all) Disable all log channels',
                description: 'Silence all dev logging',
                value:       '__devlog_all_off__',
            },
        );
    }

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder:        'Choose a background setting',
        title:              'Notebook Background Settings',
        ignoreFocusOut:     true,
        matchOnDescription: true,
    });

    if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return;

    // ── Handle selection ──────────────────────────────────────────────────
    if (pick.value === '') {
        await updateNotebookSettings(notebook, { backgroundColor: '' });
        vscode.window.showInformationMessage('Background color reset to default');

    } else if (pick.value === '__custom__') {
        const input = await vscode.window.showInputBox({
            prompt:         'Enter a CSS color value',
            placeHolder:    '#RRGGBB   or   rgb(r,g,b)   or   CSS named color',
            value:          cur.backgroundColor || '#FFFFFF',
            ignoreFocusOut: true,
            validateInput:  val => {
                if (!val) return 'Please enter a color value';
                const ok = /^#[0-9a-fA-F]{3,8}$/.test(val)
                        || /^rgba?\([^)]+\)$/.test(val.trim())
                        || /^[a-zA-Z]+$/.test(val.trim());
                return ok ? null : 'Enter a valid CSS color (e.g. #FFF8F0)';
            },
        });
        if (input) {
            await updateNotebookSettings(notebook, { backgroundColor: input.trim() });
            vscode.window.showInformationMessage(`Background color set to ${input.trim()}`);
        }

    } else if (pick.value === '__bg_image__') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany:  false,
            filters:        { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
            title:          'Select background image',
        });
        if (uris && uris[0]) {
            const imgPath = uris[0].fsPath;
            try {
                const stat = fs.statSync(imgPath);
                if (stat.size > 4 * 1024 * 1024) {
                    const ok = await vscode.window.showWarningMessage(
                        `This image is large (${Math.round(stat.size / 1024)} KB). Using it as a background may slow rendering. Continue?`,
                        'Use anyway', 'Cancel'
                    );
                    if (ok !== 'Use anyway') return;
                }
            } catch (_) {}
            await updateNotebookSettings(notebook, { backgroundImagePath: imgPath });
            vscode.window.showInformationMessage(`Background image set to: ${path.basename(imgPath)}`);
        }

    } else if (pick.value === '__bg_image_clear__') {
        await updateNotebookSettings(notebook, { backgroundImagePath: '' });
        vscode.window.showInformationMessage('Background image removed');

    } else if (pick.value === '__select_kernel__') {
        await vscode.commands.executeCommand('wolfbook.selectKernel');

    } else if (pick.value === '__mcp_toggle__') {
        const wasEnabled = configCompat.getSetting('mcpEnabled', true);
        const newState   = !wasEnabled;
        await vscode.workspace.getConfiguration('wolfbook').update('mcpEnabled', newState, vscode.ConfigurationTarget.Workspace);
        const label = newState ? 'enabled' : 'disabled';
        const action = await vscode.window.showWarningMessage(
            `MCP Server ${label}. Reload the window to apply this change.`,
            'Reload Now'
        );
        if (action === 'Reload Now') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }

    } else if (pick.value === '__prompt_switch__') {
        await _setActivePromptName(pick._promptName);
        setImmediate(() => showSettingsUI(notebook));

    } else if (pick.value === '__prompt_edit__') {
        const activePromptName = _getActivePromptName();
        const promptPath = _getActivePromptPath();
        let currentText = '';
        try { currentText = fs.readFileSync(promptPath, 'utf8'); } catch (e) {
            vscode.window.showErrorMessage('Could not read prompt: ' + e.message);
            return;
        }
        const newText = await _showSystemPromptEditor(currentText, activePromptName);
        if (newText !== undefined) {
            try {
                fs.writeFileSync(promptPath, newText, 'utf8');
                vscode.window.showInformationMessage(`Prompt "${activePromptName}" saved — takes effect on next @wolfbook chat`);
            } catch (e) {
                vscode.window.showErrorMessage('Could not save prompt: ' + e.message);
            }
        }

    } else if (pick.value === '__prompt_new__') {
        const name = await vscode.window.showInputBox({
            prompt:        'Name for new prompt preset',
            placeHolder:   'e.g. integrability, paper-review',
            ignoreFocusOut: true,
            validateInput: v => (v && /^[a-zA-Z0-9_-]+$/.test(v.trim())) ? null : 'Use letters, digits, - or _ only',
        });
        if (name) {
            const trimmed = name.trim();
            const dstPath = path.join(_PROMPTS_DIR, trimmed + '.md');
            try {
                fs.copyFileSync(_getActivePromptPath(), dstPath);
                _setActivePromptName(trimmed);
                vscode.window.showInformationMessage(`Preset "${trimmed}" created and activated`);
                setImmediate(() => showSettingsUI(notebook));
            } catch (e) {
                vscode.window.showErrorMessage('Could not create preset: ' + e.message);
            }
        }

    } else if (pick.value === '__prompt_delete__') {
        const activePromptName = _getActivePromptName();
        const confirm = await vscode.window.showWarningMessage(
            `Delete preset "${activePromptName}"? This cannot be undone.`,
            'Delete', 'Cancel'
        );
        if (confirm === 'Delete') {
            try { fs.unlinkSync(_getActivePromptPath()); } catch (_) {}
            const remaining = _listPrompts();
            if (remaining.length > 0) _setActivePromptName(remaining[0].name);
            setImmediate(() => showSettingsUI(notebook));
        }

    } else if (pick.value === '__reset__') {
        await updateNotebookSettings(notebook, { backgroundColor: '', backgroundImagePath: '', copilotPrePrompt: '' });
        vscode.window.showInformationMessage('All notebook customizations reset');

    } else if (pick.value === '__devlog_toggle__') {
        // Toggle a single channel — xor the flag
        const newMask = getLogMask() ^ pick._channelFlag;
        setLogMask(newMask);
        const state = (newMask & pick._channelFlag) ? 'ON' : 'OFF';
        vscode.window.showInformationMessage(`Log channel "${LOG_CHANNEL_LABELS[pick._channelKey]}" is now ${state}`);
        // Reopen the settings UI so the state is visually updated
        setImmediate(() => showSettingsUI(notebook));

    } else if (pick.value === '__devlog_all_on__') {
        const allMask = Object.values(LOG_CHANNELS).reduce((a, b) => a | b, 0);
        setLogMask(allMask);
        vscode.window.showInformationMessage('All developer log channels enabled');
        setImmediate(() => showSettingsUI(notebook));

    } else if (pick.value === '__devlog_all_off__') {
        setLogMask(0);
        vscode.window.showInformationMessage('All developer log channels disabled');
        setImmediate(() => showSettingsUI(notebook));

    } else {
        // Named palette color
        await updateNotebookSettings(notebook, { backgroundColor: pick.value });
        vscode.window.showInformationMessage(`Background color set to ${pick.label}`);
    }
}

// ── Settings store helpers ────────────────────────────────────────────────────
function getNotebookSettings(notebook) {
    const uri = notebook.uri.toString();
    if (notebookSettingsStore.has(uri)) return notebookSettingsStore.get(uri);
    const legacy = notebook.metadata?.wolframSettings || {};
    const appearances = vscode.workspace.getConfiguration('wolfbook').get(_APPEARANCE_KEY, {}) || {};
    const local = appearances[uri] || {};
    const settings = {
        ...legacy,
        backgroundColor: Object.prototype.hasOwnProperty.call(local, 'backgroundColor')
            ? local.backgroundColor : (legacy.backgroundColor || ''),
        backgroundImagePath: Object.prototype.hasOwnProperty.call(local, 'backgroundImagePath')
            ? local.backgroundImagePath : (legacy.backgroundImagePath || ''),
    };
    notebookSettingsStore.set(uri, settings);
    // One-way, non-document migration: preserve an existing appearance locally
    // so future Dropbox metadata changes from collaborators cannot make it blink.
    if (!appearances[uri] && (legacy.backgroundColor || legacy.backgroundImagePath)) {
        const migrated = { backgroundColor: legacy.backgroundColor || '', backgroundImagePath: legacy.backgroundImagePath || '' };
        vscode.workspace.getConfiguration('wolfbook').update(
            _APPEARANCE_KEY, { ...appearances, [uri]: migrated }, vscode.ConfigurationTarget.Global
        ).catch(() => {});
    }
    return settings;
}

async function updateNotebookSettings(notebook, newSettings) {
    const uri             = notebook.uri.toString();
    const currentSettings = getNotebookSettings(notebook);
    const updatedSettings = { ...currentSettings, ...newSettings };
    notebookSettingsStore.set(uri, updatedSettings);

    const appearancePatch = Object.fromEntries(Object.entries(newSettings).filter(([key]) => _APPEARANCE_FIELDS.has(key)));
    if (Object.keys(appearancePatch).length) {
        const cfg = vscode.workspace.getConfiguration('wolfbook');
        const appearances = cfg.get(_APPEARANCE_KEY, {}) || {};
        const previous = appearances[uri] || {};
        await cfg.update(_APPEARANCE_KEY, {
            ...appearances,
            [uri]: { ...previous, ...appearancePatch },
        }, vscode.ConfigurationTarget.Global);
    }

    const documentPatch = Object.fromEntries(Object.entries(newSettings).filter(([key]) => !_APPEARANCE_FIELDS.has(key)));
    if (Object.keys(documentPatch).length) {
        const edit = new vscode.WorkspaceEdit();
        const legacy = notebook.metadata?.wolframSettings || {};
        const metadata = { ...notebook.metadata, wolframSettings: { ...legacy, ...documentPatch } };
        edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
        await vscode.workspace.applyEdit(edit);
    }
    await applyNotebookSettings(notebook);
}

// ── Color math helpers ────────────────────────────────────────────────────────
// percent > 0 → lighten (towards 255); percent < 0 → darken (towards 0)
function adjustColor(color, percent) {
    const num  = parseInt(color.replace("#", ""), 16);
    const r    = (num >> 16);
    const g    = (num >> 8) & 0x00FF;
    const b    = num & 0x0000FF;
    let newR, newG, newB;
    if (percent >= 0) {
        newR = Math.min(255, Math.max(0, Math.round(r + (255 - r) * percent)));
        newG = Math.min(255, Math.max(0, Math.round(g + (255 - g) * percent)));
        newB = Math.min(255, Math.max(0, Math.round(b + (255 - b) * percent)));
    } else {
        // Darken: shift towards 0
        const p = -percent;
        newR = Math.min(255, Math.max(0, Math.round(r * (1 - p))));
        newG = Math.min(255, Math.max(0, Math.round(g * (1 - p))));
        newB = Math.min(255, Math.max(0, Math.round(b * (1 - p))));
    }
    return "#" + ((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1);
}

function createBorderColor(color, isDark) {
    const num   = parseInt(color.replace("#", ""), 16);
    const delta = isDark ? 20 : -20;
    const r     = Math.min(255, Math.max(0, (num >> 16) + delta));
    const g     = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + delta));
    const b     = Math.min(255, Math.max(0, (num & 0x0000FF) + delta));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// ── Apply settings ────────────────────────────────────────────────────────────
async function applyNotebookSettings(notebook) {
    const settings = getNotebookSettings(notebook);
    const uri      = notebook.uri.toString();
    devLog(LOG_CHANNELS.EXTENSION, '[NotebookSettings] Applying settings for:', uri, JSON.stringify(settings));

    // 1. Background color via workbench.colorCustomizations
    const config        = vscode.workspace.getConfiguration('workbench');
    const currentColors = config.get('colorCustomizations') || {};

    if (settings.backgroundColor) {
        const baseColor = _autoInvertColor(settings.backgroundColor);
        const isHex     = /^#[0-9a-fA-F]{3,8}$/.test(baseColor);
        const updated   = { ...currentColors };
        const isDark    = _isDarkTheme();

        if (isHex) {
            if (isDark) {
                // Dark theme: outer bg slightly lighter than base, cell interior
                // slightly darker — gives subtle depth while keeping corner
                // cutout areas (which show cellEditorBackground) blending in.
                // Small delta keeps absolute RGB diff ≤ ~6 per channel.
                const _outerBg = adjustColor(baseColor, 0.03);   // slightly lighter outer bg
                const _cellBg  = adjustColor(baseColor, -0.06);  // slightly darker cell interior
                updated['notebook.editorBackground']                = _outerBg;
                updated['notebook.cellEditorBackground']            = _cellBg;
                updated['notebook.cellBorderColor']                 = createBorderColor(baseColor, true);
                updated['notebook.inactiveFocusedCellBorder']       = createBorderColor(baseColor, true);
                updated['notebook.collapsedCellBackground']         = adjustColor(baseColor, -0.08);
                // Set ALL cell-container background tokens to match outer bg so that
                // the rounded corner cutouts (outside cell-editor-part) are seamless.
                updated['notebook.focusedCellBackground']           = _outerBg;
                updated['notebook.selectedCellBackground']          = _outerBg;
                updated['notebook.inactiveSelectedCellBackground']  = _outerBg;
                updated['notebook.cellHoverBackground']             = _outerBg;
            } else {
                const _outerBg = adjustColor(baseColor, 0.08);
                updated['notebook.editorBackground']                = _outerBg;
                updated['notebook.cellEditorBackground']            = adjustColor(baseColor, 0.35);
                updated['notebook.cellBorderColor']                 = createBorderColor(baseColor, false);
                updated['notebook.inactiveFocusedCellBorder']       = createBorderColor(baseColor, false);
                updated['notebook.collapsedCellBackground']         = adjustColor(baseColor, 0.35);
                // Set ALL cell-container background tokens to match outer bg
                updated['notebook.focusedCellBackground']           = _outerBg;
                updated['notebook.selectedCellBackground']          = _outerBg;
                updated['notebook.inactiveSelectedCellBackground']  = _outerBg;
                updated['notebook.cellHoverBackground']             = _outerBg;
            }
        } else {
            // rgb(...) or named color — set directly (no lighten/darken math)
            updated['notebook.editorBackground']               = baseColor;
            updated['notebook.cellEditorBackground']           = baseColor;
            updated['notebook.focusedCellBackground']          = baseColor;
            updated['notebook.selectedCellBackground']         = baseColor;
            updated['notebook.inactiveSelectedCellBackground'] = baseColor;
            updated['notebook.cellHoverBackground']            = baseColor;
        }
        if (!_notebookColorsUnchanged(currentColors, updated)) {
            await config.update('colorCustomizations', updated, vscode.ConfigurationTarget.Global);
        }

    } else if (!settings.backgroundImagePath) {
        // No colour and no image. Distinguish a never-configured notebook (fresh,
        // e.g. created by wolfbook_newNotebook) from an explicit "Default (None)" pick:
        //   • never configured  → paint a neutral gray so VS Code's default BLUE
        //                          focused/selected-cell highlight does not leak through.
        //   • explicit '' (None) → strip custom notebook colours (raw VS Code theme).
        const everConfigured = notebookSettingsStore.has(uri) ||
            !!(notebook.metadata && notebook.metadata.wolframSettings);
        if (!everConfigured) {
            const isDark = _isDarkTheme();
            const base   = isDark ? DEFAULT_BG_GRAY_DARK : DEFAULT_BG_GRAY_LIGHT;
            const outer  = adjustColor(base, isDark ? 0.03 : 0.08);
            const cellBg = adjustColor(base, isDark ? -0.06 : 0.35);
            const border = createBorderColor(base, isDark);
            const updated = {
                ...currentColors,
                'notebook.editorBackground':               outer,
                'notebook.cellEditorBackground':           cellBg,
                'notebook.cellBorderColor':                border,
                'notebook.inactiveFocusedCellBorder':      border,
                'notebook.collapsedCellBackground':        cellBg,
                'notebook.focusedCellBackground':          outer,
                'notebook.selectedCellBackground':         outer,
                'notebook.inactiveSelectedCellBackground': outer,
                'notebook.cellHoverBackground':            outer,
            };
            if (!_notebookColorsUnchanged(currentColors, updated)) {
                await config.update('colorCustomizations', updated, vscode.ConfigurationTarget.Global);
            }
        } else if (_NOTEBOOK_COLOR_KEYS.some(k => currentColors[k])) {
            const updated = { ...currentColors };
            for (const k of _NOTEBOOK_COLOR_KEYS) delete updated[k];
            await config.update('colorCustomizations', updated, vscode.ConfigurationTarget.Global);
        }
    }

    // 2. Background image via renderer messaging (applies to cell output webviews)
    const msg = getRendererMsg();
    if (!msg) return;
    if (settings.backgroundImagePath) {
        try {
            await _broadcastBgImage(settings.backgroundImagePath);
        } catch (err) {
            console.error('[NotebookSettings] Failed to broadcast bg-image:', err);
            vscode.window.showErrorMessage(`Background image error: ${err.message}`);
        }
    } else {
        try { msg.postMessage({ type: 'bg-image', dataUrl: null }); } catch (_) {}
    }

    // 3. Copilot instructions — inject into all Copilot chats via workspace setting
    await _applyCopilotInstructions(settings.copilotPrePrompt || '');
}

// Tag used to identify wolfbook-managed entries in codeGeneration.instructions
const _WB_INSTR_TAG = '[wolfbook-notebook-instructions] ';

async function _applyCopilotInstructions(prePrompt) {
    try {
        const cfg      = vscode.workspace.getConfiguration('github.copilot.chat');
        const existing = cfg.get('codeGeneration.instructions') || [];
        // Remove any previous wolfbook-managed entry, then prepend new one if set
        const filtered = existing.filter(item =>
            !(typeof item.text === 'string' && item.text.startsWith(_WB_INSTR_TAG))
        );
        const updated = prePrompt
            ? [{ text: _WB_INSTR_TAG + prePrompt }, ...filtered]
            : filtered;
        await cfg.update('codeGeneration.instructions', updated.length ? updated : undefined,
            vscode.ConfigurationTarget.Workspace);
    } catch (_) {}
}

// ── Wolfbook system prompt editor (webview panel) ─────────────────────────
function _showSystemPromptEditor(initialText, promptName) {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'wolfbook.systemPromptEditor',
            'Wolfbook Prompt: ' + (promptName || 'default'),
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        let resolved = false;
        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            panel.dispose();
            resolve(value);
        };

        panel.onDidDispose(() => {
            if (!resolved) { resolved = true; resolve(undefined); }
        });

        panel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'save')   finish(msg.text);
            if (msg.command === 'cancel') finish(undefined);
        });

        const escHtml = (s) => s
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    margin: 0; padding: 16px; height: 100vh; box-sizing: border-box;
    display: flex; flex-direction: column; font-family: var(--vscode-font-family);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    overflow: hidden;
  }
  h3 { margin: 0 0 4px; font-size: 14px; }
  .hint { font-size: 12px; opacity: 0.7; margin-bottom: 10px; }
  textarea {
    flex: 1; width: 100%; box-sizing: border-box; resize: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
    padding: 10px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .buttons { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; flex-shrink: 0; }
  button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <h3>Wolfbook System Prompt</h3>
  <div class="hint">This text is fed to every @wolfbook chat. Describes available tools and conventions. Cmd+S to save.</div>
  <textarea id="editor">${escHtml(initialText)}</textarea>
  <div class="buttons">
    <button class="btn-secondary" id="btnCancel">Cancel</button>
    <button class="btn-primary" id="btnSave">Save</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const ta = document.getElementById('editor');
    ta.focus();
    document.getElementById('btnSave').addEventListener('click', () => {
        vscode.postMessage({ command: 'save', text: ta.value });
    });
    document.getElementById('btnCancel').addEventListener('click', () => {
        vscode.postMessage({ command: 'cancel' });
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); vscode.postMessage({ command: 'cancel' }); }
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            vscode.postMessage({ command: 'save', text: ta.value });
        }
    });
  </script>
</body>
</html>`;
    });
}

exports.BACKGROUND_COLORS = BACKGROUND_COLORS;
// Canonical list of workbench.colorCustomizations keys this module writes.
// Exported so the kernel-offline gray/restore cycle (kernel/lifecycle.js) operates
// on the EXACT same set — otherwise coloured cell elements are left un-grayed while
// the kernel reloads, or only partially restored once it is alive again.
exports.NOTEBOOK_COLOR_KEYS = _NOTEBOOK_COLOR_KEYS;
