const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let escapeAliases = {};
let isInEscapeMode = false;
let escapeBuffer = '';
let escapeStartPosition = null;
let escapeDecorationType = null;
let emptyEscapeDecorationType = null;

function registerEscapeMode(context, extensionPath) {
    // Load aliases
    const aliasPath = path.join(extensionPath, 'wolfram_escape_aliases.json');
    if (fs.existsSync(aliasPath)) {
        escapeAliases = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
        console.log(`[Escape Mode] Loaded ${Object.keys(escapeAliases).length} aliases`);
    } else {
        console.error('[Escape Mode] Could not load wolfram_escape_aliases.json');
    }

    // Create decoration type for escape mode highlighting with text
    escapeDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 200, 100, 0.4)',
        border: '2px solid rgba(255, 150, 0, 0.9)',
        borderRadius: '4px'
    });

    // Create decoration type for empty escape mode with triple vertical dots like Mathematica
    emptyEscapeDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 200, 100, 0.6)',
        border: '3px solid rgba(255, 150, 0, 1.0)',
        borderRadius: '4px',
        before: {
            contentText: '⋮',
            color: 'rgba(255, 100, 0, 1.0)',
            fontWeight: 'bold',
            margin: '0 4px 0 0'
        }
    });

    // Register completion provider for escape mode
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        ['wolfram', { scheme: 'vscode-notebook-cell', language: 'wolfram' }],
        {
            provideCompletionItems(document, position, token, context) {
                if (!isInEscapeMode || !escapeStartPosition) {
                    return undefined;
                }

                // Get all aliases that start with the current buffer (case-sensitive)
                const matchingAliases = Object.keys(escapeAliases)
                    .filter(alias => {
                        // Ensure both buffer and alias are compared properly
                        if (!escapeBuffer) return true; // Show all if buffer is empty
                        return alias.indexOf(escapeBuffer) === 0; // More explicit startsWith check
                    })
                    .sort();

                // Limit to top 50 results for performance
                const topMatches = matchingAliases.slice(0, 50);

                const items = topMatches.map(alias => {
                    const info = escapeAliases[alias];
                    const item = new vscode.CompletionItem(alias, vscode.CompletionItemKind.Text);
                    item.detail = `${info.unicode} ${info.name}`;
                    item.documentation = new vscode.MarkdownString(`Insert **${info.unicode}** (\\[${info.name}\\])`);
                    
                    // Insert the Unicode character directly and replace from start position
                    item.insertText = info.unicode;
                    // Replace everything from escape start to current position
                    item.range = new vscode.Range(escapeStartPosition, position);
                    item.sortText = alias;
                    item.filterText = alias;
                    
                    // Add command to reset escape mode after insertion
                    item.command = {
                        command: 'extension.resetEscapeMode',
                        title: 'Reset Escape Mode'
                    };
                    
                    return item;
                });

                // Return a CompletionList to disable VS Code's fuzzy filtering
                return new vscode.CompletionList(items, false);
            }
        }
    );

    context.subscriptions.push(completionProvider);

    // Listen for selection changes to clean up decorations if we're not in escape mode
    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!isInEscapeMode && event.textEditor) {
            event.textEditor.setDecorations(escapeDecorationType, []);
            event.textEditor.setDecorations(emptyEscapeDecorationType, []);
        }
    });

    context.subscriptions.push(selectionChangeListener);

    // Register backtick key handler
    const disposable = vscode.commands.registerCommand('type', async (args) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return vscode.commands.executeCommand('default:type', args);
        }

        const doc = editor.document;
        const isWolframFile = doc.languageId === 'wolfram' || 
                             doc.fileName.endsWith('.evsnb') || 
                             doc.fileName.endsWith('.vsnb') ||
                             doc.uri.scheme === 'vscode-notebook-cell';

        if (!isWolframFile) {
            return vscode.commands.executeCommand('default:type', args);
        }

        // Check if backtick is pressed
        if (args.text === '`') {
            if (!isInEscapeMode) {
                // Start escape mode
                isInEscapeMode = true;
                escapeBuffer = '';
                escapeStartPosition = editor.selection.active;
                
                updateEscapeModeHighlight(editor);
                vscode.window.setStatusBarMessage('$(symbol-key) Escape mode: type alias then ` again (Ctrl+Space for suggestions)', 10000);
                
                // Trigger autocomplete
                setTimeout(() => {
                    vscode.commands.executeCommand('editor.action.triggerSuggest');
                }, 50);
            } else {
                // End escape mode - try to replace
                await tryReplaceAlias(editor);
            }
            return; // Don't type the backtick
        }

        // If in escape mode, accumulate characters and update highlight
        if (isInEscapeMode) {
            escapeBuffer += args.text;
            // Let the character be typed first
            await vscode.commands.executeCommand('default:type', args);
            // Then update the highlight
            setTimeout(() => {
                const ed = vscode.window.activeTextEditor;
                if (ed && isInEscapeMode) {
                    updateEscapeModeHighlight(ed);
                }
            }, 10);
            // Don't auto-trigger - let user press Ctrl+Space if they want suggestions
            return;
        }

        // Normal typing
        return vscode.commands.executeCommand('default:type', args);
    });

    context.subscriptions.push(disposable);

    // Handle escape key to cancel escape mode
    const escapeHandler = vscode.commands.registerCommand('extension.cancelEscapeMode', () => {
        if (isInEscapeMode) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.setDecorations(escapeDecorationType, []);
                editor.setDecorations(emptyEscapeDecorationType, []);
            }
            
            isInEscapeMode = false;
            escapeBuffer = '';
            escapeStartPosition = null;
            vscode.window.setStatusBarMessage('$(x) Escape mode cancelled', 2000);
        }
    });

    context.subscriptions.push(escapeHandler);
    
    // Register command to reset escape mode (called after completion)
    const resetEscapeModeCommand = vscode.commands.registerCommand('extension.resetEscapeMode', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.setDecorations(escapeDecorationType, []);
            editor.setDecorations(emptyEscapeDecorationType, []);
        }
        isInEscapeMode = false;
        escapeBuffer = '';
        escapeStartPosition = null;
    });

    context.subscriptions.push(resetEscapeModeCommand);
}

function updateEscapeModeHighlight(editor) {
    if (!isInEscapeMode || !escapeStartPosition) {
        // Clear all decorations if not in escape mode
        editor.setDecorations(escapeDecorationType, []);
        editor.setDecorations(emptyEscapeDecorationType, []);
        return;
    }

    const currentPos = editor.selection.active;
    
    if (escapeBuffer.length === 0) {
        // Empty escape mode - show triple dots with wider range for better visibility
        const range = new vscode.Range(currentPos, currentPos.translate(0, 2));
        editor.setDecorations(emptyEscapeDecorationType, [{ range }]);
        editor.setDecorations(escapeDecorationType, []);
    } else {
        // Has content - use normal highlighting
        const range = new vscode.Range(escapeStartPosition, currentPos);
        editor.setDecorations(escapeDecorationType, [{ range }]);
        editor.setDecorations(emptyEscapeDecorationType, []);
    }
}

async function tryReplaceAlias(editor) {
    if (!escapeBuffer || !escapeStartPosition) {
        // Clear highlighting and reset
        editor.setDecorations(escapeDecorationType, []);
        editor.setDecorations(emptyEscapeDecorationType, []);
        resetEscapeMode();
        return;
    }

    const alias = escapeAliases[escapeBuffer];
    
    if (alias) {
        // Found matching alias - replace the buffer with Unicode character
        const startPos = escapeStartPosition;
        const endPos = editor.selection.active;
        const range = new vscode.Range(startPos, endPos);

        await editor.edit(editBuilder => {
            editBuilder.replace(range, alias.unicode);
        });

        vscode.window.setStatusBarMessage(`$(check) Inserted ${alias.unicode} (${alias.name})`, 2000);
    } else {
        // No match - show warning
        vscode.window.setStatusBarMessage(`$(warning) No alias found for "${escapeBuffer}"`, 3000);
    }

    // Clear highlighting AFTER replacement
    editor.setDecorations(escapeDecorationType, []);
    editor.setDecorations(emptyEscapeDecorationType, []);

    resetEscapeMode();
}

function resetEscapeMode() {
    isInEscapeMode = false;
    escapeBuffer = '';
    escapeStartPosition = null;
}

module.exports = {
    registerEscapeMode
};
