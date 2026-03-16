"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerNotebookSettings = registerNotebookSettings;
exports.applyNotebookSettings = applyNotebookSettings;

const vscode = require("vscode");

// Light color palette for background
const BACKGROUND_COLORS = [
    { label: "Default (None)", value: "" },
    { label: "Light Cream", value: "#FFF8F0" },
    { label: "Soft Peach", value: "#FFE5E5" },
    { label: "Pale Yellow", value: "#FFFACD" },
    { label: "Light Mint", value: "#F0FFF0" },
    { label: "Powder Blue", value: "#F0F8FF" },
    { label: "Lavender Mist", value: "#F8F0FF" },
    { label: "Pale Pink", value: "#FFF0F5" },
    { label: "Light Aqua", value: "#E0FFFF" },
    { label: "Soft Lime", value: "#F5FFED" },
    { label: "Champagne", value: "#FAF0E6" },
    { label: "Pale Turquoise", value: "#E8F8F5" },
    { label: "Light Coral", value: "#FFF5F0" }
];

// Store for notebook-specific settings
const notebookSettingsStore = new Map();

function registerNotebookSettings(context) {
    // Register the settings command
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfram.notebookSettings', async () => {
            // *** DEBUG: confirm command fires ***
            vscode.window.showInformationMessage('⚙️ Notebook Settings: command fired');
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
                    vscode.window.showErrorMessage('No Wolfram notebook is open. active=' + (active && active.notebook.notebookType) + ' visible=' + notebookEditors.length);
                    return;
                }

                await showSettingsUI(wolframEditor.notebook);
            } catch (err) {
                vscode.window.showErrorMessage('Notebook Settings error: ' + err.message);
                console.error('[NotebookSettings] command error:', err);
            }
        })
    );

    // Listen for notebook open events to apply settings
    context.subscriptions.push(
        vscode.window.onDidChangeActiveNotebookEditor(editor => {
            if (editor && editor.notebook.notebookType === 'extended-wolfram-notebook') {
                applyNotebookSettings(editor.notebook);
            }
        })
    );

    // Apply settings when extension loads for already open notebooks
    vscode.window.visibleNotebookEditors.forEach(editor => {
        if (editor.notebook.notebookType === 'extended-wolfram-notebook') {
            applyNotebookSettings(editor.notebook);
        }
    });
}

async function showSettingsUI(notebook) {
    // Get current settings
    const currentSettings = getNotebookSettings(notebook);

    // Show quick pick for background color
    // ignoreFocusOut: true prevents auto-dismiss when toolbar button click steals focus
    const colorPick = await vscode.window.showQuickPick(BACKGROUND_COLORS, {
        placeHolder: 'Select background color',
        title: 'Notebook Background Color',
        ignoreFocusOut: true
    });

    if (colorPick) {
        await updateNotebookSettings(notebook, {
            backgroundColor: colorPick.value
        });
        
        vscode.window.showInformationMessage(`Background color set to ${colorPick.label}`);
    }
}

function getNotebookSettings(notebook) {
    const uri = notebook.uri.toString();
    
    // First check in-memory store
    if (notebookSettingsStore.has(uri)) {
        return notebookSettingsStore.get(uri);
    }

    // Then check notebook metadata
    if (notebook.metadata && notebook.metadata.wolframSettings) {
        const settings = notebook.metadata.wolframSettings;
        notebookSettingsStore.set(uri, settings);
        return settings;
    }

    // Default settings
    const defaultSettings = {
        backgroundColor: ""
    };
    
    return defaultSettings;
}

async function updateNotebookSettings(notebook, newSettings) {
    const uri = notebook.uri.toString();
    const currentSettings = getNotebookSettings(notebook);
    const updatedSettings = { ...currentSettings, ...newSettings };

    // Update in-memory store
    notebookSettingsStore.set(uri, updatedSettings);

    // Update notebook metadata
    const edit = new vscode.WorkspaceEdit();
    const metadata = { ...notebook.metadata, wolframSettings: updatedSettings };
    const notebookEdit = vscode.NotebookEdit.updateNotebookMetadata(metadata);
    edit.set(notebook.uri, [notebookEdit]);
    await vscode.workspace.applyEdit(edit);

    // Apply the settings immediately
    applyNotebookSettings(notebook);
}

// Helper function to lighten/darken a color
function adjustColor(color, percent) {
    // Convert hex to RGB
    const num = parseInt(color.replace("#",""), 16);
    const r = (num >> 16);
    const g = (num >> 8) & 0x00FF;
    const b = num & 0x0000FF;
    
    // Adjust brightness
    const newR = Math.min(255, Math.max(0, Math.round(r + (255 - r) * percent)));
    const newG = Math.min(255, Math.max(0, Math.round(g + (255 - g) * percent)));
    const newB = Math.min(255, Math.max(0, Math.round(b + (255 - b) * percent)));
    
    return "#" + ((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1);
}

// Helper function to create a border color from base color
function createBorderColor(color) {
    // Make border slightly darker/more saturated
    const num = parseInt(color.replace("#",""), 16);
    const r = Math.max(0, ((num >> 16) - 20));
    const g = Math.max(0, (((num >> 8) & 0x00FF) - 20));
    const b = Math.max(0, ((num & 0x0000FF) - 20));
    
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

async function applyNotebookSettings(notebook) {
    const settings = getNotebookSettings(notebook);
    const uri = notebook.uri.toString();

    console.log('[NotebookSettings] Applying settings for:', uri, settings);

    if (settings.backgroundColor) {
        const baseColor = settings.backgroundColor;
        
        // Create a harmonious color scheme:
        // - Notebook background: slightly lighter than base
        // - Cell background: much lighter (prominent, easy to read)
        // - Border: slightly darker than base for definition
        const notebookBackground = adjustColor(baseColor, 0.08); // 8% lighter than base
        const cellBackground = adjustColor(baseColor, 0.35); // 35% lighter (very light, high contrast)
        const borderColor = createBorderColor(baseColor);
        
        console.log('[NotebookSettings] Color scheme:', {
            base: baseColor,
            notebook: notebookBackground,
            cell: cellBackground,
            border: borderColor
        });
        
        // Apply colors via workspace settings
        const config = vscode.workspace.getConfiguration('workbench');
        const currentColors = config.get('colorCustomizations') || {};
        
        // Update the color customizations for notebook
        const updatedColors = {
            ...currentColors,
            'notebook.editorBackground': notebookBackground,  // Notebook background (lighter)
            'notebook.cellEditorBackground': cellBackground,  // Cell background (much lighter)
            'notebook.cellBorderColor': borderColor,          // Cell border (darker)
            'notebook.inactiveFocusedCellBorder': borderColor, // Inactive cell border
            'notebook.collapsedCellBackground': cellBackground  // Collapsed (folded) cell input
        };
        
        await config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace);
        
        vscode.window.showInformationMessage(`Notebook color scheme applied`);
    } else {
        // Remove custom colors if no background is set
        const config = vscode.workspace.getConfiguration('workbench');
        const currentColors = config.get('colorCustomizations') || {};
        
        if (currentColors['notebook.cellEditorBackground'] || currentColors['notebook.editorBackground']) {
            const updatedColors = { ...currentColors };
            delete updatedColors['notebook.cellEditorBackground'];
            delete updatedColors['notebook.editorBackground'];
            delete updatedColors['notebook.cellBorderColor'];
            delete updatedColors['notebook.inactiveFocusedCellBorder'];
            delete updatedColors['notebook.collapsedCellBackground'];
            
            await config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage('Notebook background color reset to default');
        }
    }
}

exports.BACKGROUND_COLORS = BACKGROUND_COLORS;
