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
const { scrollLog } = controller_1;
const serializer_1 = require("./serializer");
const unicode_replacer_1 = require("./unicode-replacer");
const escape_mode_1 = require("./escape-mode");
const notebook_settings_1 = require("./notebook-settings");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
const _tools = require('./tools/index');
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
    let controller = new controller_1.WolframNotebookKernel(context);
    if (nbKernelenabled) {
        controller.launchKernel();
    }
    // Register Copilot language model tools (Phase 4)
    _tools.registerTools(context, () => controller);
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
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.pasteImageCell", (args) => {
        controller.pasteImageAsCell(args || {});
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.pasteImageCellBelow", () => {
        controller.pasteImageAsCell({ insertBelow: true });
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

        // ---- Save cursor position NOW — before VS Code's Shift+Enter processing
        // exits edit mode and blurs the cell's text editor.
        const _preSaveTxtEd = vscode.window.activeTextEditor;
        if (_preSaveTxtEd) {
            controller._refineSavedCursor    = _preSaveTxtEd.selection;
            controller._refineSavedCursorUri = _preSaveTxtEd.document.uri.toString();
            scrollLog('[executeCell] pre-exec cursor saved:',
                `anchor(${_preSaveTxtEd.selection.anchor.line},${_preSaveTxtEd.selection.anchor.character})`,
                `active(${_preSaveTxtEd.selection.active.line},${_preSaveTxtEd.selection.active.character})`);
        } else {
            controller._refineSavedCursor    = null;
            controller._refineSavedCursorUri = null;
            scrollLog('[executeCell] no activeTextEditor at Shift+Enter time — cursor not saved');
        }

        const editor = vscode.window.activeNotebookEditor;
        if (!editor) return;
        const sel = editor.selections;
        if (!sel || sel.length === 0) return;
        const cell = editor.notebook.cellAt(sel[0].start);
        if (!cell || cell.kind !== vscode.NotebookCellKind.Code) return;

        // ---- PRE-EMPT VS Code's async internal scroll ----
        // execution.start() and execution.end() internally fire revealRange via rAF
        // (~16ms after our synchronous code). By calling revealRange HERE first —
        // synchronously, before controller.execute() queues anything — we establish
        // the correct viewport position. VS Code's subsequent internal scroll is then
        // either a no-op (InCenterIfOutsideViewport on an already-visible cell) or
        // aligns with our intent (AtTop for advance). The async counter-scrolls in
        // checkoutExecutionQueue remain as belt-and-suspenders backup.
        //
        // Mode detection mirrors controller.execute() logic exactly so both agree.
        {
            const _cellUri    = cell.document.uri.toString();
            const _curSrc     = cell.document.getText();
            const _lastSrc    = controller._cellLastSource.get(_cellUri);
            const _srcChanged = (_lastSrc !== undefined && _lastSrc !== _curSrc)
                             || (_lastSrc === undefined  && controller._cellDirty.has(_cellUri));
            const _autoMode   = _srcChanged ? 'refine' : 'advance';
            const _preMode    = (controller._evalModeOverride !== 'auto')
                              ? controller._evalModeOverride : _autoMode;
            // Advance: AtTop — pin cell at top immediately, VS Code's Default([n,n+2]) can't override.
            // Refine: InCenterIfOutsideViewport — no-op since cell is definitely visible right now
            // (we're still in the synchronous Shift+Enter handler). Just ensures it stays visible.
            // The real freeze logic is in the dynamic checks at t=0/16/32/50ms in controller.js.
            const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
            const _preRange = new RC(cell.index, cell.index + 1);
            if (_preMode === 'refine') {
                editor.revealRange(_preRange, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
                scrollLog('[executeCell-preempt] refine: InCenterIfOutsideViewport (no-op, cell visible) cell', cell.index);
            } else {
                editor.revealRange(_preRange, vscode.NotebookEditorRevealType.AtTop);
                scrollLog('[executeCell-preempt] advance: AtTop cell', cell.index);
            }
        }

        // Note: markKeyboardExecution is intentionally NOT called here.
        // execute() determines the eval mode (Advance vs Refine) from cell
        // source history and calls markKeyboardExecution internally with the
        // correct mode. Mode detection above is read-only (no side-effects).
        controller.execute([cell], editor.notebook, controller._controller);
    }));

    // Eval mode toggle commands — cycle: auto → advance → refine → auto
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.evalMode.auto", () => {
        controller.setEvalMode('advance');  // auto was active → switch to advance
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.evalMode.advance", () => {
        controller.setEvalMode('refine');   // advance was active → switch to refine
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfram.evalMode.refine", () => {
        controller.setEvalMode('auto');     // refine was active → reset to auto
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
    
    context.subscriptions.push(vscode.workspace.registerNotebookSerializer(
        NOTEBOOK_TYPE,
        new serializer_1.VSNBContentSerializer(),
        // Mark execution-related cell metadata as transient so VS Code does not
        // include it in conflict detection when the file changes on disk (Dropbox sync).
        { transientCellMetadata: { executionSummary: true, lastRunDuration: true, runStartTime: true } }
    ), controller);
    
    // Setup Unicode replacer for \[Name] -> Unicode conversion
    const extensionPath = context.extensionPath;
    (0, unicode_replacer_1.registerUnicodeReplacer)(context, extensionPath);
    
    // Completion provider for Dynamic[...] lifetime options.
    // Triggers after a comma inside Dynamic[...] and offers LiveTime/LiveEvaluations.
    const _dynOptionCompletions = [
        {
            label: 'LiveTime',
            detail: 'LiveTime -> t',
            doc:    'Stop the Dynamic widget and remove its output after t seconds (wall-clock).\nExample: Dynamic[n, LiveTime -> 10]',
            insert: 'LiveTime -> '
        },
        {
            label: 'LiveEvaluations',
            detail: 'LiveEvaluations -> n',
            doc:    'Stop the Dynamic widget and remove its output after n cell-level dispatches\nhave been sent to the main kernel since the widget started.\nExample: Dynamic[n, LiveEvaluations -> 2]',
            insert: 'LiveEvaluations -> '
        }
    ];
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            [{ language: 'wolfram' }, { pattern: '**/*.evsnb' }, { pattern: '**/*.vsnb' }],
            {
                provideCompletionItems(document, position) {
                    const linePrefix = document.lineAt(position).text.slice(0, position.character);
                    // Only suggest inside Dynamic[..., <here>]
                    if (!linePrefix.includes('Dynamic[') || !linePrefix.includes(',')) return undefined;
                    return _dynOptionCompletions.map(opt => {
                        const item = new vscode.CompletionItem(opt.label, vscode.CompletionItemKind.Property);
                        item.insertText = opt.insert;
                        item.detail     = opt.detail;
                        item.documentation = new vscode.MarkdownString(opt.doc);
                        item.sortText   = '0' + opt.label; // float to top
                        return item;
                    });
                }
            },
            ',', ' ', 'L'  // trigger on comma, space, or 'L' (LiveTime/LiveEvaluations)
        )
    );

    // Setup Escape Mode (` key for Mathematica-style aliases)
    (0, escape_mode_1.registerEscapeMode)(context, extensionPath);
    console.log('[Extension] Escape mode registered');
    
    // Setup Notebook Settings
    (0, notebook_settings_1.registerNotebookSettings)(context);
    console.log('[Extension] Notebook settings registered');

    // ---- One-time macOS file-association prompt ----
    // Asks the user once whether to register .wb/.evsnb/.vsnb with VS Code in
    // the macOS Launch Services database so Finder opens them automatically.
    // Stored in globalState so it only fires once per installation.

    // Shared helper — runs the actual duti + lsregister work.
    // Uses a stub WolfbookOpener.app that exports the com.wolfbook.wb UTI so that
    // macOS Launch Services accepts VS Code as the handler (VS Code itself doesn't
    // declare these extensions in its own Info.plist, so direct duti per-extension fails).
    const _runFileAssoc = () => {
        const cp = require('child_process');
        const _fs = require('fs');
        const _path = require('path');
        const os = require('os');

        // ---- 1. Find duti ----
        const dutiCandidates = ['/opt/homebrew/bin/duti', '/usr/local/bin/duti'];
        const duti = dutiCandidates.find(p => _fs.existsSync(p));
        if (!duti) {
            vscode.window.showWarningMessage(
                'duti not found — required to register file types on macOS. Install with: brew install duti',
                'Copy command'
            ).then(btn => {
                if (btn === 'Copy command')
                    vscode.env.clipboard.writeText('brew install duti');
            });
            context.globalState.update('wolfbook.fileAssocPrompted', false);
            return;
        }

        // ---- 2. Ensure WolfbookOpener.app stub exists in ~/Applications ----
        const stubApp = _path.join(os.homedir(), 'Applications', 'WolfbookOpener.app');
        const contentsDir = _path.join(stubApp, 'Contents');
        const macosDir = _path.join(contentsDir, 'MacOS');
        try {
            _fs.mkdirSync(macosDir, { recursive: true });
            _fs.mkdirSync(_path.join(contentsDir, 'Resources'), { recursive: true });
        } catch (e) { /* already exists */ }

        // ---- 2b. Copy bundled .icns to stub app Resources so Finder shows the icon ----
        const icnsSrc = _path.join(context.extensionPath, 'icons', 'wolfbook_doc.icns');
        const icnsDst = _path.join(contentsDir, 'Resources', 'wolfbook_doc.icns');
        try {
            if (_fs.existsSync(icnsSrc)) _fs.copyFileSync(icnsSrc, icnsDst);
        } catch (e) { /* non-fatal */ }

        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>    <string>com.wolfbook.opener</string>
    <key>CFBundleName</key>          <string>WolfbookOpener</string>
    <key>CFBundleVersion</key>       <string>1.1</string>
    <key>CFBundlePackageType</key>   <string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>10.13</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>      <string>Wolfbook Notebook</string>
            <key>CFBundleTypeRole</key>       <string>Editor</string>
            <key>LSHandlerRank</key>          <string>Owner</string>
            <key>CFBundleTypeIconFile</key>   <string>wolfbook_doc</string>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>wb</string>
                <string>evsnb</string>
                <string>vsnb</string>
            </array>
            <key>LSItemContentTypes</key>
            <array><string>com.wolfbook.wb</string></array>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key>     <string>com.wolfbook.wb</string>
            <key>UTTypeDescription</key>    <string>Wolfbook Notebook</string>
            <key>UTTypeIconFile</key>       <string>wolfbook_doc</string>
            <key>UTTypeConformsTo</key>
            <array><string>public.plain-text</string></array>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>wb</string>
                    <string>evsnb</string>
                    <string>vsnb</string>
                </array>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

        _fs.writeFileSync(_path.join(contentsDir, 'Info.plist'), plist);
        _fs.writeFileSync(_path.join(contentsDir, 'PkgInfo'), 'APPL????');

        // Minimal launcher if no binary present
        const exeBin = _path.join(macosDir, 'WolfbookOpener');
        if (!_fs.existsSync(exeBin)) {
            const launcher = '#!/bin/bash\nexec /usr/local/bin/code "$@" 2>/dev/null || ' +
                'exec "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" "$@"\n';
            _fs.writeFileSync(exeBin, launcher);
            _fs.chmodSync(exeBin, 0o755);
        }

        const lsreg = '/System/Library/Frameworks/CoreServices.framework/Frameworks/' +
                      'LaunchServices.framework/Support/lsregister';

        // ---- 3. Rebuild LS database FIRST (wipes stale entries) ----
        try {
            cp.execFileSync(lsreg,
                ['-kill', '-r', '-domain', 'local', '-domain', 'system', '-domain', 'user'],
                { timeout: 20000 });
        } catch (e) { /* non-fatal */ }

        // ---- 4. Register stub AFTER rebuild so it's fresh in the new DB ----
        try { cp.execFileSync(lsreg, ['-f', stubApp]); } catch (e) { /* non-fatal */ }

        // ---- 5. Set VS Code as handler via UTI (AFTER both steps above) ----
        let ok = false;
        try {
            cp.execFileSync(duti, ['-s', 'com.microsoft.VSCode', 'com.wolfbook.wb', 'all']);
            ok = true;
        } catch (e) { /* reported below */ }

        if (ok) {
            // Also auto-set the VS Code file icon theme
            vscode.workspace.getConfiguration()
                .update('workbench.iconTheme', 'wolfbook-file-icons',
                        vscode.ConfigurationTarget.Global)
                .then(() => {}, () => {});
            vscode.window.showInformationMessage(
                '✅ .wb, .evsnb and .vsnb files will now open in VS Code from Finder. Wolfbook file icons enabled.');
        } else {
            vscode.window.showWarningMessage(
                'File association failed — duti could not set VS Code as handler for com.wolfbook.wb.');
        }
    };

    // Command palette: "Wolfbook: Register File Types with Finder" — runnable any time.
    if (process.platform === 'darwin') {
        context.subscriptions.push(
            vscode.commands.registerCommand('wolfram.registerFileTypes', _runFileAssoc)
        );
    }

    // First-launch prompt (macOS only, fires once per install).
    if (process.platform === 'darwin' && !context.globalState.get('wolfbook.fileAssocPrompted')) {
        context.globalState.update('wolfbook.fileAssocPrompted', true);
        vscode.window.showInformationMessage(
            'Wolfbook: Associate .wb, .evsnb and .vsnb files with VS Code so Finder opens them automatically?',
            'Yes, associate', 'Not now'
        ).then(answer => {
            if (answer === 'Yes, associate') _runFileAssoc();
        });
    }

    // Silently ensure the Wolfbook icon theme is active on every activation,
    // unless the user explicitly reverted it (flag === false).
    // This survives reinstalls because globalState persists across extension updates.
    if (context.globalState.get('wolfbook.iconThemeAutoSet') !== false) {
        const cfg = vscode.workspace.getConfiguration();
        const currentTheme = cfg.get('workbench.iconTheme');
        if (currentTheme !== 'wolfbook-file-icons') {
            cfg.update('workbench.iconTheme', 'wolfbook-file-icons',
                       vscode.ConfigurationTarget.Global)
               .then(() => {
                   vscode.window.showInformationMessage(
                       'Wolfbook file icons enabled in the Explorer.',
                       'Revert'
                   ).then(btn => {
                       if (btn === 'Revert') {
                           vscode.workspace.getConfiguration()
                               .update('workbench.iconTheme',
                                       currentTheme === undefined ? null : currentTheme,
                                       vscode.ConfigurationTarget.Global)
                               .then(() => {}, () => {});
                           // Remember user preference — don't re-apply automatically
                           context.globalState.update('wolfbook.iconThemeAutoSet', false);
                       }
                   });
               }, () => {});
        }
        context.globalState.update('wolfbook.iconThemeAutoSet', true);
    }

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