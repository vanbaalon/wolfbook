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

                // Read actual document text between escape start and cursor.
                // Covers both typed-in aliases AND pre-existing text the cursor moved over.
                const escapeRange = new vscode.Range(escapeStartPosition, position);
                const currentText = document.getText(escapeRange);

                // Get all aliases that start with the current text (case-sensitive)
                const matchingAliases = Object.keys(escapeAliases)
                    .filter(alias => {
                        if (!currentText) return true; // Show all if nothing yet
                        return alias.indexOf(currentText) === 0;
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

    // Listen for selection changes — update highlight when cursor moves in escape mode,
    // or clean up decorations if not in escape mode.
    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (isInEscapeMode && event.textEditor) {
            // Update highlight as cursor moves over pre-existing text
            updateEscapeModeHighlight(event.textEditor);
        } else if (!isInEscapeMode && event.textEditor) {
            event.textEditor.setDecorations(escapeDecorationType, []);
            event.textEditor.setDecorations(emptyEscapeDecorationType, []);
        }
    });

    context.subscriptions.push(selectionChangeListener);

    // Register character accumulator — intercepts keypresses while in escape mode
    // so typed characters build up the alias buffer.  Backtick is no longer special
    // (falls through to normal typing).  Escape key is handled by wolfram.escapeKey below.
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

        // Normal typing (backtick is now just typed as-is)
        return vscode.commands.executeCommand('default:type', args);
    });

    context.subscriptions.push(disposable);

    // --- wolfram.escapeKey ---
    // Bound to the Escape key (see keybindings in package.json).
    // First press:  start escape mode (Mathematica-style alias entry).
    // Second press: commit the alias if found, or cancel if no match.
    // The suggestWidgetVisible guard in the keybinding ensures Escape still
    // closes the autocomplete popup normally before reaching this command.
    const escapeKeyCommand = vscode.commands.registerCommand('wolfram.escapeKey', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const doc = editor.document;
        const isWolframFile = doc.languageId === 'wolfram' ||
                             doc.fileName.endsWith('.evsnb') ||
                             doc.fileName.endsWith('.vsnb') ||
                             doc.uri.scheme === 'vscode-notebook-cell';
        if (!isWolframFile) return;

        if (!isInEscapeMode) {
            // Start escape mode
            isInEscapeMode = true;
            escapeBuffer = '';
            escapeStartPosition = editor.selection.active;
            vscode.commands.executeCommand('setContext', 'wolframInEscapeMode', true);

            updateEscapeModeHighlight(editor);
            vscode.window.setStatusBarMessage(
                '$(symbol-key) Escape mode: type alias then Esc again (Ctrl+Space for suggestions)', 10000);

            // Trigger autocomplete to show alias candidates immediately
            setTimeout(() => {
                vscode.commands.executeCommand('editor.action.triggerSuggest');
            }, 50);
        } else {
            // Hide suggestion widget first (single-press exit), then commit.
            await vscode.commands.executeCommand('hideSuggestWidget');
            await tryReplaceAlias(editor);
        }
    });
    context.subscriptions.push(escapeKeyCommand);

    // extension.cancelEscapeMode: programmatic cancel (e.g. from tests or other code)
    const escapeHandler = vscode.commands.registerCommand('extension.cancelEscapeMode', () => {
        if (isInEscapeMode) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.setDecorations(escapeDecorationType, []);
                editor.setDecorations(emptyEscapeDecorationType, []);
            }
            resetEscapeMode();
            vscode.window.setStatusBarMessage('$(x) Escape mode cancelled', 2000);
        }
    });
    context.subscriptions.push(escapeHandler);

    // extension.resetEscapeMode: called by completion item command after insertion
    const resetEscapeModeCommand = vscode.commands.registerCommand('extension.resetEscapeMode', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.setDecorations(escapeDecorationType, []);
            editor.setDecorations(emptyEscapeDecorationType, []);
        }
        resetEscapeMode();
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
    
    // Check if cursor moved from start — covers both typed text AND pre-existing text.
    if (currentPos.isEqual(escapeStartPosition)) {
        // Empty escape mode - show triple dots with wider range for better visibility
        const range = new vscode.Range(currentPos, currentPos.translate(0, 2));
        editor.setDecorations(emptyEscapeDecorationType, [{ range }]);
        editor.setDecorations(escapeDecorationType, []);
    } else {
        // Has content (typed or pre-existing) - use normal highlighting
        const range = new vscode.Range(escapeStartPosition, currentPos);
        editor.setDecorations(escapeDecorationType, [{ range }]);
        editor.setDecorations(emptyEscapeDecorationType, []);
    }
}

async function tryReplaceAlias(editor) {
    const startPos = escapeStartPosition;
    const endPos   = editor.selection.active;

    if (!startPos) {
        editor.setDecorations(escapeDecorationType, []);
        editor.setDecorations(emptyEscapeDecorationType, []);
        resetEscapeMode();
        return;
    }

    // Read actual document text between escape-start and current cursor.
    // This handles BOTH typed-in aliases AND pre-existing text the cursor moved over.
    const range   = new vscode.Range(startPos, endPos);
    const docText = editor.document.getText(range);

    if (!docText) {
        // Cursor didn't move — just cancel
        editor.setDecorations(escapeDecorationType, []);
        editor.setDecorations(emptyEscapeDecorationType, []);
        resetEscapeMode();
        return;
    }

    const alias = escapeAliases[docText];

    if (alias) {
        // Found matching alias - replace with Unicode character
        await editor.edit(editBuilder => {
            editBuilder.replace(range, alias.unicode);
        });
        vscode.window.setStatusBarMessage(`$(check) Inserted ${alias.unicode} (${alias.name})`, 2000);
    } else {
        // No match - show warning
        vscode.window.setStatusBarMessage(`$(warning) No alias found for "${docText}"`, 3000);
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
    vscode.commands.executeCommand('setContext', 'wolframInEscapeMode', false);
}

module.exports = {
    registerEscapeMode
};
