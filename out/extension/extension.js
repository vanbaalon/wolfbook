"use strict";
/*
 *  wolfbook
 *
 *  Copyright (c) 2026 Nikolay Gromov. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  LSP client layer based on vscode-wolfram by Wolfram Research (Apache 2.0).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = void 0;
const open = require('open');
const path = require('path');
const os = require('os');
const fs = require('fs');
const find_kernel_1 = require("./find-kernel");
const vscode = require("vscode");
const controller_1 = require("./controller");
const serializer_1 = require("./serializer");
const unicode_replacer_1 = require("./unicode-replacer");
const escape_mode_1 = require("./escape-mode");
const notebook_settings_1 = require("./notebook-settings");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
const NOTEBOOK_TYPE = 'extended-wolfram-notebook';
let extensionKernel = new find_kernel_1.FindKernel();
let client;
let wolframTmpDir;
let kernel_initialized = false;
let implicitTokensDecorationType = vscode.window.createTextEditorDecorationType({});
function activate(context) {
    const config = vscode.workspace.getConfiguration("wolfram", null);
    // Setup the menu
    context.subscriptions.push(vscode_1.commands.registerCommand('wolfram.OpenNotebook', (name) => { if (name) {
        open(name.fsPath);
    } }));
    context.subscriptions.push(vscode_1.commands.registerCommand('wolfram.DownloadWolframEngine', onDownloadWolframEngine));
    context.subscriptions.push(vscode.commands.registerCommand("wolfram.openConfigurations", async () => {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:wolfbook.wolfbook");
    }));
    let mainKernel = extensionKernel.resolveKernel();
    const download_WEngine_MDString = new vscode.MarkdownString(`[Download Wolfram Engine for kernel support.](https://www.wolfram.com/engine/)`);
    download_WEngine_MDString.supportHtml = true;
    download_WEngine_MDString.isTrusted = true;
    /*
        kernel setting is Automatic and kernel could not be found. As LSP and Notebook kernels
        are same as mainKernel, these kernels will also be missing. So no point of going further.
        Show error message here.
    */
    if (mainKernel === "kernel-not-found") {
        vscode.window.showErrorMessage("Kernel is not found in the default location. Either change \"System Kernel\" in the configuration or " + download_WEngine_MDString.value);
        return;
    }
    ;
    if (!fs.existsSync(mainKernel)) {
        vscode.window.showErrorMessage("Kernel executable path does not exist: " + mainKernel + ". Either change \"System Kernel\" in the configuration or " + download_WEngine_MDString.value);
        return;
    }
    // Add Terminal
    let terminalKernel = mainKernel;
    if (process.platform === "win32") {
        terminalKernel = terminalKernel.replace("WolframKernel.exe", "wolfram.exe");
    }
    ;
    context.subscriptions.push(vscode_1.commands.registerCommand('createWolframScriptTerminal', () => {
        // Reads systemKernel configuration value, and resolve the kernel
        // For defaulkt value, it will resolve to the actual path
        // For any kernel path is given in the configuration, it will be used
        const wolframscriptTerminal = vscode_1.window.createTerminal(`WolframKernel`, terminalKernel);
        wolframscriptTerminal.show();
    }));
    // Setup Notebook client
    let nbKernelenabled = config.get("notebook.kernelEnabled", true);
    let controller = new controller_1.WolframNotebookKernel();
    if (nbKernelenabled) {
        controller.launchKernel();
    }
    ;
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.launchKernel", () => {
        if (nbKernelenabled) {
            client.outputChannel.appendLine("Launching Wolfram Kernel");
            controller.launchKernel();
        }
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.abortEvaluation", () => {
        controller.abortEvaluation();
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.openDialogSubsession", () => {
        controller.openDialogSubsession();
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.restartKernel", () => {
        controller.restartKernel();
    }));

    // Execute cell via keyboard (Shift+Enter): bypasses VS Code's built-in
    // auto-scroll so we can do our own minimal-scroll behaviour after output lands.
    //
    // SCROLL DEBUG: disabled inherited VS Code auto-scroll — location: extension.js wolfram.executeCell
    // VS Code's built-in notebook.cell.execute immediately scrolls to the output cell
    // when execution starts (before any output exists — inherited Jupyter behaviour).
    // We intercept Shift+Enter here instead, so the scroll only fires after first output.
    // console.log('[scroll] notebook.cell.execute auto-scroll') ← original built-in, bypassed here
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.executeCell", () => {
        console.log('[scroll] Shift+Enter detected — evaluation triggered, waiting for first output');
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) return;
        const sel = editor.selections;
        if (!sel || sel.length === 0) return;
        const cell = editor.notebook.cellAt(sel[0].start);
        if (!cell || cell.kind !== vscode.NotebookCellKind.Code) return;
        controller.markKeyboardExecution(cell);
        controller.execute([cell], editor.notebook, controller._controller);
    }));
    
    // Format switching commands
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.setOutputFormatImage", async () => {
        console.log('[Extension] Setting output format to Image');
        await vscode.workspace.getConfiguration('wolfram').update('notebook.rendering.outputFormat', 'Image', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to Image (PNG)');
        console.log('[Extension] Config updated, current value:', vscode.workspace.getConfiguration('wolfram').get('notebook.rendering.outputFormat'));
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.setOutputFormatHTML", async () => {
        console.log('[Extension] Setting output format to HTML');
        await vscode.workspace.getConfiguration('wolfram').update('notebook.rendering.outputFormat', 'HTML', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to HTML');
        console.log('[Extension] Config updated, current value:', vscode.workspace.getConfiguration('wolfram').get('notebook.rendering.outputFormat'));
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.setOutputFormatMathML", async () => {
        console.log('[Extension] Setting output format to MathML');
        await vscode.workspace.getConfiguration('wolfram').update('notebook.rendering.outputFormat', 'MathML', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to MathML');
        console.log('[Extension] Config updated, current value:', vscode.workspace.getConfiguration('wolfram').get('notebook.rendering.outputFormat'));
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.setOutputFormatInputForm", async () => {
        console.log('[Extension] Setting output format to InputForm');
        await vscode.workspace.getConfiguration('wolfram').update('notebook.rendering.outputFormat', 'InputForm', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to InputForm');
        console.log('[Extension] Config updated, current value:', vscode.workspace.getConfiguration('wolfram').get('notebook.rendering.outputFormat'));
    }));
    
    // Clear cell output command
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.clearCellOutput", async (cell) => {
        console.log('[Extension] Clear cell output command triggered');
        
        // If cell is not provided (e.g., command palette), try to get from active editor
        if (!cell) {
            const editor = vscode.window.activeNotebookEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active notebook cell found');
                return;
            }
            const activeCell = editor.notebook.cellAt(editor.selection.start);
            if (!activeCell) {
                vscode.window.showWarningMessage('No active cell found');
                return;
            }
            cell = activeCell;
        }
        
        // Clear the output
        const edit = new vscode.WorkspaceEdit();
        const nbEdit = vscode.NotebookEdit.updateCellOutputs(cell.index, []);
        edit.set(cell.notebook.uri, [nbEdit]);
        await vscode.workspace.applyEdit(edit);
        console.log('[Extension] Cell output cleared');
    }));
    
    // Expand truncated output command
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.expandTruncatedOutput", async (args) => {
        console.log('[Extension] ========================================');
        console.log('[Extension] Expand truncated output command triggered!');
        console.log('[Extension] Args received:', JSON.stringify(args));
        console.log('[Extension] Args type:', typeof args);
        
        // Extract UUID from command arguments (if provided) or fall back to last truncated
        let uuid = null;
        
        if (args && args.uuid) {
            // UUID passed from command: URI link
            uuid = args.uuid;
            console.log('[Extension] Using UUID from command args:', uuid);
        } else if (controller.lastTruncatedExecution && controller.lastTruncatedExecution.truncatedOutputId) {
            // Fallback to stored UUID (for toolbar button)
            uuid = controller.lastTruncatedExecution.truncatedOutputId;
            console.log('[Extension] Using UUID from lastTruncatedExecution:', uuid);
        } else {
            console.log('[Extension] No UUID available!');
        }
        
        if (uuid) {
            console.log('[Extension] Sending expand-output message to kernel with UUID:', uuid);
            controller.postMessageToKernel({
                type: "expand-output",
                uuid: uuid
            });
            
            vscode.window.showInformationMessage('Requesting full output...');
        } else {
            console.log('[Extension] WARNING: No truncated output to expand');
            vscode.window.showWarningMessage('No truncated output to expand');
        }
        console.log('[Extension] ========================================');
    }));
    
    context.subscriptions.push(vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new serializer_1.VSNBContentSerializer()), controller);
    
    // Setup Unicode replacer for \[Name] -> Unicode conversion
    const extensionPath = context.extensionPath;
    (0, unicode_replacer_1.registerUnicodeReplacer)(context, extensionPath);
    
    // Setup Escape Mode (` key for Mathematica-style aliases)
    (0, escape_mode_1.registerEscapeMode)(context, extensionPath);
    console.log('[Extension] Escape mode registered');
    
    // Setup Notebook Settings
    (0, notebook_settings_1.registerNotebookSettings)(context);
    console.log('[Extension] Notebook settings registered');
    
    // Setup LSP client
    let enabled = config.get("lsp.serverEnabled", true);
    if (!enabled) {
        return;
    }
    let lspcommand = config.get("advanced.lsp.command", ["lspKernel"]);
    let lspLog = config.get("advanced.lsp.ServerLogDirectory", "Off");
    // Set lspcommand to use standalone LSP app.
    // Use the default option to launch LSPServer
    if (lspcommand[0] == "lspKernel") {
        // No log directory is to be used
        if (lspLog == "Off") {
            lspcommand = [
                mainKernel,
                "-noinit",
                "-noprompt",
                "-nopaclet",
                "-noicon",
                "-nostartuppaclets",
                "-run",
                "Needs[\"LSPServer`\"];LSPServer`StartServer[]"
            ];
        }
        // log directory is a folder location, use that as the log folder
        else {
            lspcommand = [
                mainKernel,
                "-noinit",
                "-noprompt",
                "-nopaclet",
                "-noicon",
                "-nostartuppaclets",
                "-run",
                "Needs[\"LSPServer`\"]; LSPServer`$LogLevel = 1; LSPServer`StartServer[\"" + lspLog + "\"]"
            ];
        }
    }
    ;
    let implicitTokens = config.get("lsp.implicitTokens", []);
    let semanticTokens = config.get("lsp.semanticTokens", false);
    let ignoreUnicodeCharacters = config.get("lsp.ignoreUnicodeCharacters", true);
    wolframTmpDir = path.join(os.tmpdir(), "Wolfram");
    //
    // recursive option suppresses any directory-already-exists error
    //
    fs.mkdirSync(wolframTmpDir, { recursive: true });
    let opts = {
        cwd: wolframTmpDir
    };
    let serverOptions = {
        run: {
            transport: node_1.TransportKind.stdio,
            command: lspcommand[0],
            args: lspcommand.slice(1),
            options: opts
        },
        debug: {
            transport: node_1.TransportKind.stdio,
            command: lspcommand[0],
            args: lspcommand.slice(1),
            options: opts
        }
    };
    let clientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'wolfram' },
            { scheme: 'vscode-notebook-cell', language: 'wolfram' }
        ],
        initializationOptions: {
            implicitTokens: implicitTokens,
            // bracketMatcher: bracketMatcher,
            // debugBracketMatcher: debugBracketMatcher
            semanticTokens: semanticTokens,
            ignoreUnicodeCharacters: ignoreUnicodeCharacters
        }
    };
    client = new node_1.LanguageClient('wolfram', 'Wolfram-LSP', serverOptions, clientOptions);
    
    // Always filter certain noisy diagnostics from the Wolfram LSP:
    //   • Any diagnostic whose range spans only non-ASCII characters —
    //     these arise from \[Name] → Unicode replacements and are valid WL.
    //   • "unexpected expression at top level" (common in notebook cells).
    //   • "Suspicious use of session symbol" (spurious warning about Print etc.)
    client.onDidChangeState((event) => {
        if (event.newState === 2) { // Running state
            client.diagnostics.onDidChangeDiagnostics((event) => {
                event.uris.forEach((uri) => {
                    const diagnostics = client.diagnostics.get(uri);
                    if (!diagnostics || diagnostics.length === 0) return;
                    const doc = vscode_1.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                    const filtered = diagnostics.filter((diag) => {
                        const msg = diag.message;
                        // Suppress "unexpected expression at top level"
                        if (msg.toLowerCase().includes('unexpected expression at top level')) return false;
                        // Suppress "Suspicious use of session symbol" (e.g. Print, Echo)
                        if (msg.includes('Suspicious use of') && msg.includes('session symbol')) return false;
                        // Suppress any diagnostic whose range contains ONLY non-ASCII characters
                        // (these are our \[Name] → Unicode replacements — fully valid WL).
                        if (doc) {
                            const text = doc.getText(diag.range);
                            if (text && /^[^\x00-\x7F]+$/.test(text)) return false;
                        }
                        // Legacy: suppress explicit "Unexpected/Unknown character" LSP messages
                        // on ranges that contain non-ASCII text.
                        if (msg.includes('Unexpected character') ||
                            msg.includes('unexpected character') ||
                            msg.includes('Unknown character')) {
                            if (doc) {
                                const text = doc.getText(diag.range);
                                if (text && /[^\x00-\x7F]/.test(text)) return false;
                            }
                        }
                        return true; // Keep all other diagnostics
                    });
                    if (filtered.length !== diagnostics.length) {
                        client.diagnostics.set(uri, filtered);
                    }
                });
            });
        }
    });
    
    // client.outputChannel.dispose();
    let timeoutWarningEnabled = config.get("timeout_warning_enabled", true);
    if (timeoutWarningEnabled) {
        setTimeout(kernel_initialization_check_function, 15000, lspcommand);
    }
    client.start().then(() => {
        //
        // client.onStart() is called after initialize response, so it is appropriate to set kernel_initialized here
        //
        kernel_initialized = true;
        client.onNotification("textDocument/publishImplicitTokens", (params) => {
            let activeEditor = vscode_1.window.activeTextEditor;
            if (!activeEditor) {
                return;
            }
            let opts = [];
            params.tokens.forEach((t) => {
                if (!activeEditor) {
                    return;
                }
                const opt = {
                    range: new vscode_1.Range(new vscode_1.Position(t.line - 1, t.column - 1), new vscode_1.Position(t.line - 1, t.column - 1)),
                    renderOptions: {
                        before: {
                            contentText: implicitTokenCharToText(t.character),
                            color: 'gray'
                        }
                    }
                };
                opts.push(opt);
            });
            activeEditor.setDecorations(implicitTokensDecorationType, opts);
        });
    });
}
exports.activate = activate;
function kernel_initialization_check_function(command) {
    if (kernel_initialized) {
        return;
    }
    let kernel = command[0];
    //
    // User knows that the kernel did not start properly, so do not also display timeout error
    //
    if (!fs.existsSync(kernel)) {
        vscode.window.showErrorMessage("Kernel executable not found: " + kernel);
        return;
    }
    // TODO: kill kernel, if possible
    let report = vscode_1.window.createOutputChannel("Wolfram Language Error Report");
    report.appendLine("Language server kernel did not respond after 15 seconds.");
    report.appendLine("");
    report.appendLine("If the language kernel server did eventually start after this warning, then you can disable this warning with the timeout_warning_enabled setting.");
    report.appendLine("");
    report.appendLine("The most likely cause is that required paclets are not installed.");
    report.appendLine("");
    report.appendLine("The language server kernel process is hanging and may need to be killed manually.");
    report.appendLine("");
    report.appendLine("This is the command that was used:");
    report.appendLine(command.toString());
    report.appendLine("");
    report.appendLine("To ensure that required paclets are installed and up-to-date, run this in a notebook:");
    report.appendLine("");
    report.appendLine("PacletInstall[\"CodeParser\"]");
    report.appendLine("PacletInstall[\"CodeInspector\"]");
    report.appendLine("PacletInstall[\"CodeFormatter\"]");
    report.appendLine("PacletInstall[\"LSPServer\"]");
    report.appendLine("");
    report.appendLine("To help diagnose the problem, run this in a notebook:");
    report.appendLine("");
    report.appendLine("Needs[\"LSPServer`\"]");
    report.append("LSPServer`RunServerDiagnostic[{");
    command.slice(0, -1).forEach((a) => {
        //
        // important to replace \ -> \\ before replacing " -> \"
        //
        report.append("\"" + a.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"");
        report.append(", ");
    });
    report.append("\"" + command[command.length - 1].replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"");
    report.append("}, ProcessDirectory -> \"");
    report.append(wolframTmpDir.replace(/\\/g, "\\\\"));
    report.append("\"]");
    report.appendLine("");
    report.appendLine("");
    report.appendLine("Fix any problems then restart and try again.");
    //
    // FIXME: it would be great to just include the above text in the error message.
    // But VSCode does not currently allow newlines in error messages
    //
    // Related issues: https://github.com/microsoft/vscode/issues/5454
    //
    vscode_1.window.showErrorMessage("Cannot start Wolfram language server. Check Output view and open the Wolfram Language Error Report output channel for more information. ");
}
function implicitTokenCharToText(c) {
    switch (c) {
        case "x": return "\xd7";
        case "z": return " \xd7";
        // add a space before Null because it looks nicer
        case "N": return " Null";
        case "1": return "1";
        case "A": return "All";
        // add spaces before and after \u25a1 because it looks nicer
        case "e": return " \u25a1 ";
        case "f": return "\u25a1\xd7";
        case "y": return "\xd71";
        case "B": return "All\xd7";
        case "C": return "All\xd71";
        case "D": return "All1";
        default: return " ";
    }
}
function onDownloadWolframEngine() {
    const uri = vscode_1.Uri.parse(`https://www.wolfram.com/engine/`);
    vscode_1.commands.executeCommand('vscode.open', uri);
}
//# sourceMappingURL=extension.js.map