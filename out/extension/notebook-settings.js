"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerNotebookSettings = registerNotebookSettings;
exports.applyNotebookSettings = applyNotebookSettings;

const vscode = require("vscode");
const path   = require("path");
const fs     = require("fs");

// ── Colour palette ────────────────────────────────────────────────────────────
const BACKGROUND_COLORS = [
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
        vscode.commands.registerCommand('wolfram.notebookSettings', async () => {
            // Short delay so toolbar-click focus returns to notebook before QuickPick opens
            await new Promise(resolve => setTimeout(resolve, 150));
            try {
                const active = vscode.window.activeNotebookEditor;
                const notebookEditors = vscode.window.visibleNotebookEditors;
                const wolframEditor =
                    (active && active.notebook && active.notebook.notebookType === 'extended-wolfram-notebook' ? active : null) ||
                    notebookEditors.find(e => e.notebook.notebookType === 'extended-wolfram-notebook');

                console.log('[NotebookSettings] active=', active && active.notebook.notebookType, 'found=', !!wolframEditor);
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
                applyNotebookSettings(editor.notebook);
            }
        })
    );

    vscode.window.visibleNotebookEditors.forEach(editor => {
        if (editor.notebook.notebookType === 'extended-wolfram-notebook') {
            applyNotebookSettings(editor.notebook);
        }
    });
}

// ── Settings UI ───────────────────────────────────────────────────────────────
async function showSettingsUI(notebook) {
    const cur = getNotebookSettings(notebook);
    const isCustomColor = cur.backgroundColor &&
        !BACKGROUND_COLORS.find(c => c.value === cur.backgroundColor);

    // ── Colour items ──────────────────────────────────────────────────────
    const colorItems = [
        {
            label:       '$(circle-slash) Default (None)',
            description: cur.backgroundColor === '' ? '✓ current' : 'Use VS Code theme default',
            value:       '',
        },
        ...BACKGROUND_COLORS.map(c => ({
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

    // ── Full list with separators ─────────────────────────────────────────
    const items = [
        { label: 'Background Color', kind: vscode.QuickPickItemKind.Separator },
        ...colorItems,
        { label: 'Background Image', kind: vscode.QuickPickItemKind.Separator },
        ...imageItems,
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        {
            label:       '$(discard) Reset all customizations',
            description: 'Remove background color and image',
            value:       '__reset__',
        },
    ];

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

    } else if (pick.value === '__reset__') {
        await updateNotebookSettings(notebook, { backgroundColor: '', backgroundImagePath: '' });
        vscode.window.showInformationMessage('All notebook background customizations reset');

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
    if (notebook.metadata && notebook.metadata.wolframSettings) {
        const settings = notebook.metadata.wolframSettings;
        notebookSettingsStore.set(uri, settings);
        return settings;
    }
    return { backgroundColor: '', backgroundImagePath: '' };
}

async function updateNotebookSettings(notebook, newSettings) {
    const uri             = notebook.uri.toString();
    const currentSettings = getNotebookSettings(notebook);
    const updatedSettings = { ...currentSettings, ...newSettings };
    notebookSettingsStore.set(uri, updatedSettings);

    const edit         = new vscode.WorkspaceEdit();
    const metadata     = { ...notebook.metadata, wolframSettings: updatedSettings };
    const notebookEdit = vscode.NotebookEdit.updateNotebookMetadata(metadata);
    edit.set(notebook.uri, [notebookEdit]);
    await vscode.workspace.applyEdit(edit);
    await applyNotebookSettings(notebook);
}

// ── Color math helpers ────────────────────────────────────────────────────────
function adjustColor(color, percent) {
    const num  = parseInt(color.replace("#", ""), 16);
    const r    = (num >> 16);
    const g    = (num >> 8) & 0x00FF;
    const b    = num & 0x0000FF;
    const newR = Math.min(255, Math.max(0, Math.round(r + (255 - r) * percent)));
    const newG = Math.min(255, Math.max(0, Math.round(g + (255 - g) * percent)));
    const newB = Math.min(255, Math.max(0, Math.round(b + (255 - b) * percent)));
    return "#" + ((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1);
}

function createBorderColor(color) {
    const num = parseInt(color.replace("#", ""), 16);
    const r   = Math.max(0, (num >> 16) - 20);
    const g   = Math.max(0, ((num >> 8) & 0x00FF) - 20);
    const b   = Math.max(0, (num & 0x0000FF) - 20);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// ── Apply settings ────────────────────────────────────────────────────────────
async function applyNotebookSettings(notebook) {
    const settings = getNotebookSettings(notebook);
    const uri      = notebook.uri.toString();
    console.log('[NotebookSettings] Applying settings for:', uri, JSON.stringify(settings));

    // 1. Background color via workbench.colorCustomizations
    const config        = vscode.workspace.getConfiguration('workbench');
    const currentColors = config.get('colorCustomizations') || {};

    if (settings.backgroundColor) {
        const baseColor = settings.backgroundColor;
        const isHex     = /^#[0-9a-fA-F]{3,8}$/.test(baseColor);
        const updated   = { ...currentColors };

        if (isHex) {
            updated['notebook.editorBackground']          = adjustColor(baseColor, 0.08);
            updated['notebook.cellEditorBackground']      = adjustColor(baseColor, 0.35);
            updated['notebook.cellBorderColor']           = createBorderColor(baseColor);
            updated['notebook.inactiveFocusedCellBorder'] = createBorderColor(baseColor);
            updated['notebook.collapsedCellBackground']   = adjustColor(baseColor, 0.35);
        } else {
            // rgb(...) or named color — set directly (no lighten/darken math)
            updated['notebook.editorBackground']     = baseColor;
            updated['notebook.cellEditorBackground'] = baseColor;
        }
        await config.update('colorCustomizations', updated, vscode.ConfigurationTarget.Workspace);

    } else if (!settings.backgroundImagePath) {
        // No color and no image — strip custom notebook colors
        if (currentColors['notebook.cellEditorBackground'] || currentColors['notebook.editorBackground']) {
            const updated = { ...currentColors };
            delete updated['notebook.cellEditorBackground'];
            delete updated['notebook.editorBackground'];
            delete updated['notebook.cellBorderColor'];
            delete updated['notebook.inactiveFocusedCellBorder'];
            delete updated['notebook.collapsedCellBackground'];
            await config.update('colorCustomizations', updated, vscode.ConfigurationTarget.Workspace);
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
}

exports.BACKGROUND_COLORS = BACKGROUND_COLORS;
