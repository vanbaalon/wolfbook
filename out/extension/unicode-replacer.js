"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUnicodeReplacer = void 0;

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// Load Unicode mappings
let unicodeMappings = null;
let replacementMap = null;

function loadUnicodeMappings(extensionPath) {
    if (!unicodeMappings) {
        try {
            const mappingsPath = path.join(extensionPath, 'EditorVariation', 'unicode_mappings_filtered.json');
            const data = fs.readFileSync(mappingsPath, 'utf8');
            unicodeMappings = JSON.parse(data);
            
            // Create a map for fast lookup: \[Name] -> Unicode character
            replacementMap = new Map();
            unicodeMappings.forEach(mapping => {
                replacementMap.set(mapping.mathematica, mapping.unicode);
            });
            
            console.log(`[Unicode Replacer] Loaded ${replacementMap.size} Unicode character mappings from ${mappingsPath}`);
        } catch (error) {
            console.error('[Unicode Replacer] Failed to load Unicode mappings:', error);
        }
    }
    return replacementMap;
}

function registerUnicodeReplacer(context, extensionPath) {
    console.log('[Unicode Replacer] registerUnicodeReplacer called with extensionPath:', extensionPath);
    // Load mappings
    const mappings = loadUnicodeMappings(extensionPath);
    if (!mappings) {
        console.error('[Unicode Replacer] Not activated: mappings failed to load');
        return;
    }

    console.log('[Unicode Replacer] Auto-replacement active on text change');

    // Listen for text changes in the active editor
    const changeDisposable = vscode.workspace.onDidChangeTextDocument(event => {
        // Check if auto-replacement is enabled
        const config = vscode.workspace.getConfiguration('wolfram');
        const autoReplaceEnabled = config.get('editor.autoReplaceUnicode', true);
        
        if (!autoReplaceEnabled) {
            return;
        }
        
        const editor = vscode.window.activeTextEditor;
        if (!editor || event.document !== editor.document) {
            return;
        }
        
        const doc = event.document;
        
        // Check if this is a notebook cell or wolfram file
        const isNotebookCell = doc.uri.scheme === 'vscode-notebook-cell';
        const isWolframFile = doc.languageId === 'wolfram';
        const isVsnbFile = doc.fileName && (doc.fileName.endsWith('.vsnb') || doc.fileName.endsWith('.evsnb'));
        
        if (!isNotebookCell && !isWolframFile && !isVsnbFile) {
            return;
        }

        // Process each content change
        for (const change of event.contentChanges) {
            // Only process if text was added (not deleted)
            if (change.text.length === 0) {
                continue;
            }

            // Get the line that was changed
            const startLine = change.range.start.line;
            const line = doc.lineAt(startLine);
            const lineText = line.text;
            
            // Only scan if line contains \[
            if (!lineText.includes('\\[')) {
                continue;
            }

            console.log(`[Unicode Replacer] Text changed in line ${startLine}: "${lineText}"`);
            
            // Get cursor position to avoid replacing patterns we're still typing
            const cursorPos = editor.selection.active.character;
            
            // Find ALL \[Name] patterns in the changed line and replace them
            const pattern = '\\\\\\[' + '([A-Za-z][A-Za-z0-9]*)' + '\\]';
            const regex = new RegExp(pattern, 'g');
            let match;
            const replacements = [];
            
            while ((match = regex.exec(lineText)) !== null) {
                const matchStart = match.index;
                const matchEnd = match.index + match[0].length;
                
                // Skip if cursor is inside this pattern (user is still typing)
                if (cursorPos > matchStart && cursorPos < matchEnd) {
                    console.log(`[Unicode Replacer] Skipping ${match[0]} - cursor inside at position ${cursorPos}`);
                    continue;
                }
                
                const mathematicaNotation = match[0]; // e.g., \[Alpha]
                const unicodeChar = mappings.get(mathematicaNotation);
                
                if (unicodeChar) {
                    console.log(`[Unicode Replacer] Replacing ${mathematicaNotation} → ${unicodeChar}`);
                    replacements.push({
                        range: new vscode.Range(
                            new vscode.Position(startLine, matchStart),
                            new vscode.Position(startLine, matchEnd)
                        ),
                        text: unicodeChar,
                        notation: mathematicaNotation
                    });
                }
            }
            
            // Apply all replacements
            if (replacements.length > 0) {
                console.log(`[Unicode Replacer] Applying ${replacements.length} replacements`);
                
                editor.edit(editBuilder => {
                    for (const repl of replacements) {
                        editBuilder.replace(repl.range, repl.text);
                    }
                }, { undoStopBefore: false, undoStopAfter: false });
            }
        }
    });
    
    // Clean up on deactivation
    context.subscriptions.push(changeDisposable);

    // Register command for manual conversion of selection
    const commandDisposable = vscode.commands.registerCommand('wolfram.convertToUnicode', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const document = editor.document;
        const selection = editor.selection;
        const text = document.getText(selection);

        // Replace all \[Name] patterns with Unicode
        let converted = text;
        const pattern = new RegExp('\\\\\\[([A-Za-z][A-Za-z0-9]*)\\\\\\]', 'g');
        
        converted = text.replace(pattern, (match) => {
            const unicodeChar = mappings.get(match);
            return unicodeChar || match;
        });

        if (converted !== text) {
            editor.edit(editBuilder => {
                editBuilder.replace(selection, converted);
            });
        }
    });

    // Register completion provider for \[ trigger
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        [
            { language: 'wolfram' },
            { pattern: '**/*.vsnb' }
        ],
        {
            provideCompletionItems(document, position) {
                const linePrefix = document.lineAt(position).text.substr(0, position.character);
                
                // Check if we're after \[
                if (!linePrefix.endsWith('\\[')) {
                    return undefined;
                }

                const completions = [];
                
                // Create completion items for all Unicode characters (skip entries with empty name)
                unicodeMappings.forEach(mapping => {
                    if (!mapping || !mapping.name) return;
                    const item = new vscode.CompletionItem(mapping.name, vscode.CompletionItemKind.Text);
                    item.insertText = mapping.name + ']';
                    item.detail = `${mapping.unicode} (U+${mapping.hex.substring(2).toUpperCase()})`;
                    item.documentation = `Insert ${mapping.mathematica} → ${mapping.unicode}`;
                    
                    // Add aliases as filter text for better search
                    if (mapping.aliases && mapping.aliases.length > 0) {
                        item.filterText = mapping.name + ' ' + mapping.aliases.join(' ');
                    }
                    
                    completions.push(item);
                });

                return completions;
            }
        },
        '[' // Trigger on '[' after '\'
    );

    context.subscriptions.push(changeDisposable, commandDisposable, completionProvider);
    console.log('Unicode replacer activated');
}

exports.registerUnicodeReplacer = registerUnicodeReplacer;
