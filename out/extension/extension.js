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
exports.deactivate = exports.activate = void 0;
const open = require('open');
const path = require('path');
const os = require('os');
const fs = require('fs');
// Module-level controller reference so deactivate() can call quitKernel().
let _activeController = null;
const find_kernel_1 = require("./find-kernel");
const vscode = require("vscode");
const controller_1 = require("./controller");
const { scrollLog } = controller_1;
const { devLog, LOG_CHANNELS } = require('./utils/dev-logger');
const serializer_1 = require("./serializer");
const unicode_replacer_1 = require("./unicode-replacer");
const escape_mode_1 = require("./escape-mode");
const _scrollMgr = require("./scroll/manager");
const notebook_settings_1 = require("./notebook-settings");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
const configCompat = require('./config-compat');
const _tools = require('./tools/index');
const { wlSanitizeForLSP } = require('./namedchars');

/** Convert hover Markdown text to a minimal HTML string for the Watch panel. */

const NOTEBOOK_TYPE = 'extended-wolfram-notebook';
let extensionKernel = new find_kernel_1.FindKernel();
let client;
let wolframTmpDir;
let kernel_initialized = false;
let implicitTokensDecorationType = vscode.window.createTextEditorDecorationType({});
async function activate(context) {
    // Show a loading indicator while the extension activates
    const _loadingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    _loadingStatus.text = '$(loading~spin) Wolfbook loading…';
    _loadingStatus.show();
    const _dismissLoading = () => { try { _loadingStatus.dispose(); } catch (_) {} };
    // Dismiss after activation completes (end of this function)
    // or after 8s safety timeout
    const _loadingTimeout = setTimeout(_dismissLoading, 8000);

    await configCompat.migrateLegacySettings([
        'evalMode',
        'lsp.serverEnabled',
        'notebook.kernelEnabled',
        'editor.autoReplaceUnicode',
        'timeout_warning_enabled',
        'systemKernel',
        'advanced.lsp.ServerLogDirectory',
        'advanced.notebook.logDirectory',
        'advanced.lsp.command',
        'lsp.implicitTokens',
        'lsp.semanticTokens',
        'lsp.ignoreUnicodeCharacters',
        'editor.globalSymbolColor',
        'notebook.rendering.invertBrightnessInDarkThemes',
        'notebook.rendering.imageScalingFactor',
        'notebook.rendering.outputFormat',
        'notebook.rendering.lineBreaking.baseFontSizePx',
        'notebook.rendering.lineBreaking.indentStep',
        'notebook.rendering.lineBreaking.maxDelimDepth',
        'notebook.rendering.lineBreaking.maxIterations',
        'notebook.rendering.lineBreaking.compact',
        'notebook.textOutput.pageWidth',
        'notebook.print.pageWidth',
        'notebook.customCSS'
    ]);
    const _legacyLineBreaking = vscode.workspace.getConfiguration('wolfram').inspect('notebook.rendering.lineBreaking');
    const _newLineBreaking = vscode.workspace.getConfiguration('wolfbook').inspect('notebook.rendering.lineBreakingEnabled');
    const _hasNewLineBreaking = _newLineBreaking && (
        _newLineBreaking.workspaceFolderValue !== undefined
        || _newLineBreaking.workspaceValue !== undefined
        || _newLineBreaking.globalValue !== undefined
    );
    if (!_hasNewLineBreaking && _legacyLineBreaking) {
        if (_legacyLineBreaking.workspaceFolderValue !== undefined) {
            await vscode.workspace.getConfiguration('wolfbook').update('notebook.rendering.lineBreakingEnabled', _legacyLineBreaking.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        if (_legacyLineBreaking.workspaceValue !== undefined) {
            await vscode.workspace.getConfiguration('wolfbook').update('notebook.rendering.lineBreakingEnabled', _legacyLineBreaking.workspaceValue, vscode.ConfigurationTarget.Workspace);
        }
        if (_legacyLineBreaking.globalValue !== undefined) {
            await vscode.workspace.getConfiguration('wolfbook').update('notebook.rendering.lineBreakingEnabled', _legacyLineBreaking.globalValue, vscode.ConfigurationTarget.Global);
        }
    }

    const config = configCompat.getConfiguration();

    // Hoisted here so wolfram.expandHoverDoc command (registered below) can close over it
    // even though the LSP client (which populates it) is set up later.
    const _hoverDocCache = new Map();  // key → full vscode.Hover

    // Setup the menu
    context.subscriptions.push(vscode_1.commands.registerCommand('wolfbook.OpenNotebook', (name) => { if (name) {
        open(name.fsPath);
    } }));
    context.subscriptions.push(vscode_1.commands.registerCommand('wolfbook.DownloadWolframEngine', onDownloadWolframEngine));
    context.subscriptions.push(vscode.commands.registerCommand("wolfbook.openConfigurations", async () => {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:wolfbook.wolfbook");
    }));

    // ── Select Kernel command ──────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("wolfbook.selectKernel", async () => {
        const { FindKernel } = require('./find-kernel');
        const finder = new FindKernel();
        const kernels = finder.discoverKernels();
        const current = configCompat.getSetting("systemKernel", "Automatic");

        const items = [];
        // "Automatic" option
        items.push({
            label: '$(sparkle) Automatic',
            description: kernels.length > 0 ? `→ ${kernels[0].label}` : '',
            detail: 'Use the first detected kernel',
            _path: 'Automatic',
            picked: current === 'Automatic'
        });
        // Each discovered kernel
        for (const k of kernels) {
            const isCurrent = current === k.path;
            items.push({
                label: `${isCurrent ? '$(check) ' : ''}${k.label}`,
                description: k.description,
                detail: k.path,
                _path: k.path,
                picked: isCurrent
            });
        }
        // Browse option
        items.push({
            label: '$(folder-opened) Browse…',
            description: '',
            detail: 'Choose a custom kernel executable',
            _path: '__browse__'
        });

        const pick = await vscode.window.showQuickPick(items, {
            title: 'Select Wolfram Kernel',
            placeHolder: 'Choose a kernel (current: ' + (current === 'Automatic' ? 'Automatic' : current) + ')',
            matchOnDetail: true
        });
        if (!pick) return;

        let selectedPath = pick._path;
        if (selectedPath === '__browse__') {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: 'Select Wolfram Kernel Executable',
                openLabel: 'Select Kernel'
            });
            if (!uris || uris.length === 0) return;
            selectedPath = uris[0].fsPath;
        }

        await configCompat.updateSetting("systemKernel", selectedPath, vscode.ConfigurationTarget.Global);
        const action = await vscode.window.showInformationMessage(
            `Kernel set to: ${selectedPath}. Restart kernel to apply.`,
            'Restart Kernel'
        );
        if (action === 'Restart Kernel') {
            await vscode.commands.executeCommand('wolfbook.restartKernel');
        }
    }));

    // Register settings command early — before kernel guard, so it works even without a kernel
    (0, notebook_settings_1.registerNotebookSettings)(context);
    devLog(LOG_CHANNELS.EXTENSION, '[Extension] Notebook settings registered (early)');

    // ── Debugger (Stages 4-7) ── instantiated early so keybindings work immediately
    const { BreakpointManager }    = require('./debugger/breakpointManager');
    const { WatchPanelProvider, VIEW_ID: DBG_VIEW_ID } = require('./debugger/watchPanel');
    const { AskSpecialistPanel, VIEW_ID: ASK_VIEW_ID } = require('./tools/askSpecialistPanel');
    const { DebugController }      = require('./debugger/debugController');
    const { WolframDebugAdapter }  = require('./debugger/wolframDebugAdapter');

    const _bpMgr       = new BreakpointManager(context);
    // Seed _bpMgr from any native breakpoints already present (set before this workspace loaded)
    for (const bp of vscode.debug.breakpoints) {
        if (!(bp instanceof vscode.SourceBreakpoint)) continue;
        if (bp.location.uri.scheme !== 'vscode-notebook-cell') continue;
        _bpMgr.addBreakpointAt(bp.location.uri.toString(), bp.location.range.start.line);
    }
    const _watchPanel  = new WatchPanelProvider();
    const _askPanel    = new AskSpecialistPanel();
    const _debugCtrl   = new DebugController(() => controller, _bpMgr, _watchPanel);

    // ── Evaluate Selection ─────────────────────────────────────────────────
    const evalSel = require('./editor/evaluateSelection');
    evalSel.register(context, () => controller, _watchPanel);
    require('./execution/global-symbols').register(context);

    // ── WL Code Formatter ──────────────────────────────────────────────────
    try {
        const { format: wlFormat } = require('./wl-formatter');

        function _getFormatterOpts(overrides) {
            const cfg = vscode.workspace.getConfiguration('wolfbook');
            return {
                lineWidth: cfg.get('formatter.pageLength', 150),
                replaceNamedChars: cfg.get('formatter.replaceNamedChars', false),
                ...overrides
            };
        }

        function _formatDocument(editor, opts) {
            const doc  = editor.document;
            const text = doc.getText();
            let formatted;
            try {
                formatted = wlFormat(text, opts);
            } catch (e) {
                vscode.window.showErrorMessage('Wolfbook formatter error: ' + e.message);
                return Promise.resolve(false);
            }
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(text.length)
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, fullRange, formatted);
            return vscode.workspace.applyEdit(edit);
        }

        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.format', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            _formatDocument(editor, _getFormatterOpts({}));
        }));

        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.formatWithUTF', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            _formatDocument(editor, _getFormatterOpts({ replaceNamedChars: true }));
        }));

        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.formatWithUTFWide', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            _formatDocument(editor, _getFormatterOpts({ replaceNamedChars: true, lineWidth: 200 }));
        }));

        // Compute minimal TextEdits so formatting doesn't nuke the undo stack.
        // Splits old/new text into lines, finds the first and last differing line,
        // and returns a single replacement covering only the changed region.
        function _computeMinimalEdits(doc, oldText, newText) {
            const oldLines = oldText.split('\n');
            const newLines = newText.split('\n');
            // Find first differing line
            let top = 0;
            while (top < oldLines.length && top < newLines.length && oldLines[top] === newLines[top]) top++;
            if (top === oldLines.length && oldLines.length === newLines.length) return []; // identical
            // Find last differing line (from end)
            let botOld = oldLines.length - 1;
            let botNew = newLines.length - 1;
            while (botOld > top && botNew > top && oldLines[botOld] === newLines[botNew]) { botOld--; botNew--; }
            const startPos = new vscode.Position(top, 0);
            const endPos = top <= botOld
                ? new vscode.Position(botOld, oldLines[botOld].length)
                : new vscode.Position(top, 0);
            const replacement = newLines.slice(top, botNew + 1).join('\n');
            return [vscode.TextEdit.replace(new vscode.Range(startPos, endPos), replacement)];
        }

        context.subscriptions.push(
            vscode.languages.registerDocumentFormattingEditProvider(
                [{ language: 'wolfram' }, { scheme: 'vscode-notebook-cell' }],
                {
                    provideDocumentFormattingEdits(doc) {
                        if (doc.languageId === 'markdown') return [];
                        const text = doc.getText();
                        try {
                            const formatted = wlFormat(text, _getFormatterOpts({ replaceNamedChars: true }));
                            if (formatted === text) return [];
                            return _computeMinimalEdits(doc, text, formatted);
                        } catch (e) {
                            return [];
                        }
                    }
                }
            )
        );

        context.subscriptions.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(
                [{ language: 'wolfram' }, { scheme: 'vscode-notebook-cell' }],
                {
                    provideDocumentRangeFormattingEdits(doc, range) {
                        if (doc.languageId === 'markdown') return [];
                        const text = doc.getText(range);
                        try {
                            const formatted = wlFormat(text, _getFormatterOpts({}));
                            if (formatted === text) return [];
                            return [vscode.TextEdit.replace(range, formatted)];
                        } catch (e) {
                            return [];
                        }
                    }
                }
            )
        );

        // ── Auto-format on Enter (when wolfbook.formatter.autoFormat is enabled) ──
        // Strategy: intercept Enter via a keybinding → command.
        //   1. Format the document FIRST (no newline in the text yet, so formatter
        //      won't strip it and offsets won't shift).
        //   2. await applyEdit so the document is updated.
        //   3. Insert '\n' at the current cursor position in the formatted text.
        // The cursor ends up on the freshly-inserted blank line, correct position.
        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.handleEnter', async () => {
            const cfg = vscode.workspace.getConfiguration('wolfbook');
            if (!cfg.get('formatter.autoFormat', false)) {
                return vscode.commands.executeCommand('default:type', { text: '\n' });
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) return vscode.commands.executeCommand('default:type', { text: '\n' });

            const doc = editor.document;
            const isWolfram = doc.languageId === 'wolfram' ||
                doc.fileName.endsWith('.evsnb') || doc.fileName.endsWith('.vsnb');
            if (!isWolfram) return vscode.commands.executeCommand('default:type', { text: '\n' });

            // Format first — cursor stays at its pre-Enter position in the formatted result
            await _formatDocument(editor, _getFormatterOpts({ replaceNamedChars: true }));

            // Now insert the newline; cursor lands on the new blank line
            await vscode.commands.executeCommand('default:type', { text: '\n' });
        }));


        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.formatNotebook', async () => {
            const nb = vscode.window.activeNotebookEditor?.notebook;
            if (!nb) {
                vscode.window.showInformationMessage('No active notebook.');
                return;
            }
            const opts = _getFormatterOpts({});
            const we = new vscode.WorkspaceEdit();
            let count = 0;
            for (const cell of nb.getCells()) {
                if (cell.kind !== vscode.NotebookCellKind.Code) continue;
                const doc = cell.document;
                const text = doc.getText();
                try {
                    const formatted = wlFormat(text, opts);
                    if (formatted !== text) {
                        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
                        we.replace(doc.uri, fullRange, formatted);
                        count++;
                    }
                } catch (e) { /* skip cells that fail to parse */ }
            }
            if (count > 0) {
                await vscode.workspace.applyEdit(we);
                vscode.window.showInformationMessage(`Formatted ${count} cell(s).`);
            }
        }));

        devLog(LOG_CHANNELS.EXTENSION, '[Extension] WL code formatter registered');
    } catch (e) {
        console.error('[Extension] WL formatter failed to load, skipping:', e.message);
    }

    // Register the Watch Panel webview view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DBG_VIEW_ID, _watchPanel,
            { webviewOptions: { retainContextWhenHidden: true } })
    );

    // Register the Ask Specialist Panel webview view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ASK_VIEW_ID, _askPanel,
            { webviewOptions: { retainContextWhenHidden: true } })
    );

    // ── Watch panel background: track active .wb notebook ─────────────────
    function _updateWatchPanelBg() {
        const nb     = vscode.window.activeNotebookEditor;
        const isWb   = nb && nb.notebook.uri.fsPath.endsWith('.wb');
        const colors = isWb
            ? (vscode.workspace.getConfiguration('workbench').get('colorCustomizations') || {})
            : {};
        _watchPanel.setBackground(isWb ? (colors['notebook.cellEditorBackground'] || null) : null);
    }
    context.subscriptions.push(
        vscode.window.onDidChangeActiveNotebookEditor(() => _updateWatchPanelBg()),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('workbench.colorCustomizations')) _updateWatchPanelBg();
        })
    );
    _updateWatchPanelBg();

    // ── DAP adapter factory + config provider ──────────────────────────────
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('wolfram', {
            createDebugAdapterDescriptor(_session) {
                return new vscode.DebugAdapterInlineImplementation(
                    new WolframDebugAdapter(_debugCtrl, _bpMgr, () => controller)
                );
            }
        })
    );
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('wolfram', {
            resolveDebugConfiguration(_folder, config) {
                if (!config.cellUri) {
                    const editor = vscode.window.activeNotebookEditor;
                    if (editor && editor.selections.length > 0) {
                        const cell = editor.notebook.cellAt(editor.selections[0].start);
                        config.cellUri = cell.document.uri.toString();
                    }
                }
                config.type    = config.type    || 'wolfram';
                config.request = config.request || 'launch';
                config.name    = config.name    || 'Debug Cell';
                return config;
            }
        })
    );

    // Helper: get the currently-focused notebook cell
    function _getFocusedCell() {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) return null;
        const sel = editor.selections;
        if (!sel || sel.length === 0) return null;
        return editor.notebook.cellAt(sel[0].start);
    }

    // ── Debug commands ──────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.debugCell', () => {
        // Capture the cell URI NOW — before startDebugging() shifts focus away from
        // the notebook editor (opening the Run & Debug panel changes activeNotebookEditor).
        const cell = _getFocusedCell();
        if (!cell) { vscode.window.showInformationMessage('Select a code cell to debug.'); return; }
        vscode.debug.startDebugging(undefined, {
            type:    'wolfram',
            request: 'launch',
            name:    'Debug Cell',
            cellUri: cell.document.uri.toString(),
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.stepOver',  () => _debugCtrl.stepOver()));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.stepInto',  () => _debugCtrl.stepInto()));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.stepOut',   () => _debugCtrl.stepOut()));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.continueToBreakpoint', () => _debugCtrl.continueRun()));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.continueToEnd', () => _debugCtrl.runToEnd()));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.stop',      () => _debugCtrl.stop()));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.toggleBreakpoint', () => {
        // Delegate to the native VS Code breakpoint toggle — this creates a proper
        // SourceBreakpoint which syncs to _bpMgr via onDidChangeBreakpoints and
        // shows in the VS Code Breakpoints panel.
        vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.clearTimings', () => {
        // Exposed for manual palette use; normally auto-cleared on cell edit.
        const cell = _getFocusedCell();
        if (cell) _bpMgr.clearBreakpoints(cell); // clears BP decorations too
        // Timing clear is internal to debugCtrl — trigger via a cell edit event is preferred
    }));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.debug.openWatchInEditor', async (arg) => {
        // Invoked from debug/variables/context right-click menu.
        // VS Code passes the selected tree item; extract the expression and displayed value defensively.
        const expr       = arg?.variable?.evaluateName ?? arg?.variable?.name ?? arg?.evaluateName ?? arg?.name ?? '';
        const displayed  = arg?.variable?.value        ?? arg?.value          ?? '';
        if (!expr && !displayed) return;
        // Prefer the cached full value (already fetched at each pause via wolfbookDebug$GetWatchValues)
        const label      = expr || displayed;
        const cached     = _debugCtrl.lastWatchValues.find(v => v.name === label);
        const fullVal    = cached?.full ?? displayed;
        _debugCtrl._openWatchInEditor(label, fullVal);
    }));
    devLog(LOG_CHANNELS.EXTENSION, '[Extension] Debug commands registered (Stages 4-7)');

    // ── Breakpoint sync ──────────────────────────────────────────────────────
    // Native SourceBreakpoints (gutter click, F9, Breakpoints panel) are the
    // single source of truth.  We mirror them into _bpMgr so the Watch panel
    // can list them and so startDebugCell() can read them at launch time.
    // When a wolfram DAP session is active, VS Code sends `setBreakpoints` DAP
    // requests instead — the adapter handles those; we skip here to avoid races.
    {
        context.subscriptions.push(
            vscode.debug.onDidChangeBreakpoints(e => {
                if (vscode.debug.activeDebugSession?.type === 'wolfram') return;
                for (const bp of e.added) {
                    if (!(bp instanceof vscode.SourceBreakpoint)) continue;
                    const uri = bp.location.uri;
                    if (uri.scheme !== 'vscode-notebook-cell') continue;
                    const uriStr = uri.toString();
                    const line   = bp.location.range.start.line;
                    _bpMgr.addBreakpointAt(uriStr, line);
                    devLog(LOG_CHANNELS.DEBUGGER, '[wolfbook-bp] synced native add at line', line);
                }
                for (const bp of e.removed) {
                    if (!(bp instanceof vscode.SourceBreakpoint)) continue;
                    const uri = bp.location.uri;
                    if (uri.scheme !== 'vscode-notebook-cell') continue;
                    const uriStr = uri.toString();
                    const line   = bp.location.range.start.line;
                    _bpMgr.removeBreakpointLine(uriStr, line);
                    devLog(LOG_CHANNELS.DEBUGGER, '[wolfbook-bp] synced native remove at line', line);
                }
            })
        );
    }

    let mainKernel = extensionKernel.resolveKernel();
    const download_WEngine_MDString = new vscode.MarkdownString(`[Download Wolfram Engine for kernel support.](https://www.wolfram.com/engine/)`);
    download_WEngine_MDString.supportHtml = true;
    download_WEngine_MDString.isTrusted = true;
    /*
        kernel setting is Automatic and kernel could not be found. As LSP and Notebook kernels
        are same as mainKernel, these kernels will also be missing. So no point of going further.
        Show error message here.
    */
    let kernelAvailable = true;
    if (mainKernel === "kernel-not-found") {
        vscode.window.showWarningMessage("Kernel is not found in the default location. Either change \"System Kernel\" in the configuration or " + download_WEngine_MDString.value);
        kernelAvailable = false;
    }
    else if (!fs.existsSync(mainKernel)) {
        vscode.window.showWarningMessage("Kernel executable path does not exist: " + mainKernel + ". Either change \"System Kernel\" in the configuration or " + download_WEngine_MDString.value);
        kernelAvailable = false;
    }
    // Add Terminal
    let terminalKernel = mainKernel;
    if (process.platform === "win32") {
        terminalKernel = terminalKernel.replace("WolframKernel.exe", "wolfram.exe");
    }
    ;
    context.subscriptions.push(vscode_1.commands.registerCommand('createWolframScriptTerminal', () => {
        if (!kernelAvailable) {
            vscode.window.showWarningMessage("Kernel is not available. Configure \"System Kernel\" first.");
            return;
        }
        // Reads systemKernel configuration value, and resolve the kernel
        // For defaulkt value, it will resolve to the actual path
        // For any kernel path is given in the configuration, it will be used
        const wolframscriptTerminal = vscode_1.window.createTerminal(`WolframKernel`, terminalKernel);
        wolframscriptTerminal.show();
    }));
    // Setup Notebook client
    let nbKernelenabled = config.get("notebook.kernelEnabled", true);
    let controller = new controller_1.WolframNotebookKernel(context);
    _activeController = controller;  // expose for deactivate()
    // Refresh watch panel once kernel is fully ready (guards against early eval during init.wl)
    controller._onKernelReady = () => _debugCtrl.refreshLiveWatch();
    if (nbKernelenabled && kernelAvailable) {
        controller.launchKernel().then(() => {
            // Deferred watch refresh: variables now show actual values instead of
            // "Kernel starting…" placeholders that were blocked during init.wl.
            if (controller.kernelStatusString === 'resolved') _debugCtrl.refreshLiveWatch();
        }).catch(() => {}).then(() => {
            // Deferred watch refresh: variables now show actual values instead of
            // "Kernel starting…" placeholders that were blocked during init.wl.
            if (controller.kernelStatusString === 'resolved') _debugCtrl.refreshLiveWatch();
        }).catch(() => {});
    }
    // Register Copilot language model tools (Phase 4)
    const _toolMap = _tools.registerTools(context, () => controller, _debugCtrl, () => _askPanel);
    // Register @wolfbook chat participant
    _tools.registerChatParticipant(context, () => controller);
    // Register @wolfteam collaborative chat participant
    _tools.registerWolfteamParticipant(context, () => controller);

    // ── Claude Desktop MCP server ──────────────────────────────────────────
    // Exposes all Wolfram notebook tools to Claude via MCP HTTP/SSE protocol.
    const _mcpDisabled = !configCompat.getSetting('mcpEnabled', true);
    if (_mcpDisabled) {
        devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] MCP server disabled via wolfbook.mcpEnabled setting');
    }
    const { WolframMCPServer, loadMCPSchemas, configureClaudeDesktop, writeClaudeConfig, needsConfigUpdate, resolveNodeBinary, writeAntigravityConfig, needsAntigravityConfigUpdate, installAntigravitySkill, needsSkillInstall, writeClineConfig, needsClineConfigUpdate, getMcpInfoPayload } = require('./claude-mcp/server');
    const { WorkerServer }  = require('./claude-mcp/worker');
    const { assignClientId } = require('./claude-mcp/registry');
    const _pkgJson   = path.join(context.extensionPath, 'package.json');
    const _mcpSchema = loadMCPSchemas(_pkgJson);
    let   _mcpServer = new WolframMCPServer(_toolMap, _mcpSchema);

    // Stable client identity for this window
    const _appName  = (vscode.env && vscode.env.appName) || 'VSCode';
    const _wsName   = vscode.workspace.name ||
        path.basename(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || 'untitled');
    const _clientId = assignClientId(_appName, _wsName);
    devLog(LOG_CHANNELS.EXTENSION, `[Wolfbook MCP] Client ID: ${_clientId}`);

    // Helper: ALL open wolfbook notebook paths — loaded documents AND unloaded background tabs.
    // vscode.workspace.notebookDocuments only contains notebooks VS Code has loaded into memory.
    // Tabs opened in previous sessions (or not yet clicked) appear in tabGroups but are NOT
    // in notebookDocuments until the user activates them.  We merge both sources so the agent
    // always sees the complete picture.
    const NB_EXTS = ['.wb', '.evsnb', '.vsnb'];
    const _getOpenNbPaths = () => {
        const seen = new Set();
        // 1. Fully loaded notebook documents
        for (const nb of (vscode.workspace.notebookDocuments || [])) {
            if (nb.notebookType === 'extended-wolfram-notebook') seen.add(nb.uri.fsPath);
        }
        // 2. All editor tabs (catches unloaded background tabs)
        try {
            for (const group of (vscode.window.tabGroups?.all || [])) {
                for (const tab of (group.tabs || [])) {
                    const uri = tab.input?.uri || tab.input?.modified;
                    if (uri && NB_EXTS.some(ext => uri.fsPath.endsWith(ext))) {
                        seen.add(uri.fsPath);
                    }
                }
            }
        } catch {}
        return [...seen];
    };

    // Worker server (started after primary/secondary decision below)
    let _workerServer = null;

    // ── Eager config write (Fix 3 from diagnostics) ────────────────────────
    // Write Claude config SYNCHRONOUSLY before yielding to the event loop.
    // Registers in both Claude Desktop (claude_desktop_config.json) and
    // Claude Code CLI (~/.claude.json, projects[wsPath].mcpServers) so that
    // new installs by any user get tools visible immediately without manual steps.
    // The stdio bridge already tolerates the HTTP server not being up yet.
    const _getWsPaths = () => (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    {
        const _bridgePath = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
        const _nodeBin    = resolveNodeBinary();
        const _wsPaths    = _getWsPaths();
        if (needsConfigUpdate(_bridgePath, _nodeBin, _wsPaths)) {
            try {
                writeClaudeConfig(_bridgePath, _nodeBin, undefined, undefined, _wsPaths);
                devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Claude config written eagerly at activate()');
            } catch (e) {
                console.warn('[Wolfbook MCP] Eager config write failed:', e.message);
            }
        }
        if (needsAntigravityConfigUpdate(_bridgePath, _nodeBin)) {
            try {
                writeAntigravityConfig(_bridgePath, _nodeBin);
                devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Antigravity config written eagerly at activate()');
            } catch (e) {
                console.warn('[Wolfbook MCP] Antigravity eager config write failed:', e.message);
            }
        }
        if (needsSkillInstall()) {
            try {
                installAntigravitySkill();
                devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Antigravity skill installed at activate()');
            } catch (e) {
                console.warn('[Wolfbook MCP] Antigravity skill install failed:', e.message);
            }
        }
        if (needsClineConfigUpdate(_bridgePath, _nodeBin)) {
            try {
                const r = writeClineConfig(_bridgePath, _nodeBin);
                if (!r.skipped) devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Cline config written eagerly at activate()');
            } catch (e) {
                console.warn('[Wolfbook MCP] Cline eager config write failed:', e.message);
            }
        }
    }

    // Re-register whenever workspace folders change (user opens a new project)
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const _bridgePath = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
        const _nodeBin    = resolveNodeBinary();
        const _wsPaths    = _getWsPaths();
        try { writeClaudeConfig(_bridgePath, _nodeBin, undefined, _mcpServer.port, _wsPaths); } catch {}
        try { writeAntigravityConfig(_bridgePath, _nodeBin); } catch {}
        try { writeClineConfig(_bridgePath, _nodeBin); } catch {}
    }));

    // Track the "active" MCP server — may be replaced on election win
    let _activeMCPServer = _mcpServer;
    context.subscriptions.push({ dispose: () => _activeMCPServer.stop() });
    context.subscriptions.push({ dispose: () => _workerServer?.stop() });

    /** Shared logic to start a WorkerServer for non-primary windows (or after election). */
    const _startWorker = () => {
        const ws = new WorkerServer(_toolMap, _clientId);
        ws.updateNotebooks(_getOpenNbPaths());
        ws.onPromoted(async () => {
            devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Election won — promoting to primary');
            try {
                const newPrimary = new WolframMCPServer(_toolMap, _mcpSchema);
                await newPrimary.startAsPrimary();
                newPrimary.setOwnClientInfo(_clientId, _getOpenNbPaths());
                _activeMCPServer = newPrimary;
                _mcpServer = newPrimary;
                await newPrimary.notifyWorkers();
                devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Now primary after election');
            } catch (e) {
                console.warn('[Wolfbook MCP] Promotion failed:', e.message);
            }
        });
        ws.start().catch(e => console.warn('[Wolfbook MCP] Worker start failed:', e.message));
        return ws;
    };

    if (_mcpDisabled) {
        devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Skipping MCP server start (disabled)');
        try {
            const _bp = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
            _watchPanel.setMcpInfo(getMcpInfoPayload(_bp, resolveNodeBinary(), 0, false, true));
        } catch(e) {}
    } else {

    _mcpServer.start().then(port => {
        if (_mcpServer.isSecondary) {
            devLog(LOG_CHANNELS.EXTENSION, `[Wolfbook MCP] Secondary window — starting worker for ${_clientId}`);
            _workerServer = _startWorker();
            try { _watchPanel.setMcpInfo(getMcpInfoPayload(_bridgePath, _nodeBin, port, true, false)); } catch(e) {}
            return;
        }
        // ── We are the primary ──────────────────────────────────────────────
        _mcpServer.setOwnClientInfo(_clientId, _getOpenNbPaths());
        // Auto-set session target when Copilot resolves a notebook in this window,
        // so MCP agents inherit the target without needing an explicit wolfbook_setTarget call.
        _tools.setNotebookResolvedCallback((notebook) => {
            if (!_mcpServer._sessionTargets.has('copilot')) {
                _mcpServer._sessionTargets.set('copilot', { clientId: _clientId, notebook });
            }
        });
        devLog(LOG_CHANNELS.EXTENSION, `[Wolfbook MCP] Primary ready — port ${port}, client: ${_clientId}`);
        // Re-write config if content changed (e.g. bridge path after upgrade)
        const _bridgePath = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
        const _nodeBin    = resolveNodeBinary();
        const _wsPaths    = _getWsPaths();
        if (needsConfigUpdate(_bridgePath, _nodeBin, _wsPaths)) {
            try {
                writeClaudeConfig(_bridgePath, _nodeBin, undefined, port, _wsPaths);
                devLog(LOG_CHANNELS.EXTENSION, `[Wolfbook MCP] Claude config updated (port ${port})`);
            } catch (e) {
                console.warn('[Wolfbook MCP] Config update failed:', e.message);
            }
        }
        if (needsAntigravityConfigUpdate(_bridgePath, _nodeBin)) {
            try {
                writeAntigravityConfig(_bridgePath, _nodeBin);
                devLog(LOG_CHANNELS.EXTENSION, '[Wolfbook MCP] Antigravity config updated');
            } catch (e) {
                console.warn('[Wolfbook MCP] Antigravity config update failed:', e.message);
            }
        }
        // Push live info to the sidebar info panel
        try { _watchPanel.setMcpInfo(getMcpInfoPayload(_bridgePath, _nodeBin, port, false, false)); } catch(e) {}
    }).catch(e => {
        console.warn('[Wolfbook MCP] Server failed to start:', e.message);
    });

    } // end if (!_mcpDisabled)

    // Keep primary's and worker's notebook list fresh as notebooks open/close.
    // Uses lambdas that read _mcpServer/_workerServer at call time so election
    // promotion (which replaces _mcpServer) is picked up automatically.
    // We listen to both notebookDocument events (for loaded docs) AND tabGroups
    // changes (for unloaded background tabs).
    const _syncNotebooks = () => {
        const paths = _getOpenNbPaths();
        _mcpServer.updateOwnNotebooks?.(paths);
        _workerServer?.updateNotebooks(paths);
    };
    context.subscriptions.push(
        vscode.workspace.onDidOpenNotebookDocument(() => _syncNotebooks()),
        vscode.workspace.onDidCloseNotebookDocument(() => _syncNotebooks()),
        vscode.window.tabGroups?.onDidChangeTabs?.(() => _syncNotebooks()) ?? { dispose: () => {} }
    );

    // Command: write wolfbook MCP entry into Claude Desktop and Claude Code config
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.configureClaude', async () => {
        const port = _mcpServer.port;
        if (!port) {
            vscode.window.showErrorMessage('Wolfbook MCP server is not running. Try reloading the window.');
            return;
        }
        try {
            const { configPaths, bridgePath } = writeClaudeConfig(
                path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js'),
                resolveNodeBinary(), undefined, port, _getWsPaths()
            );
            const action = await vscode.window.showInformationMessage(
                `Claude configured ✓ (${configPaths.length} file(s) updated, bridge: ${path.basename(bridgePath)}). Restart Claude to apply.`,
                'Open Claude Code Settings'
            );
            if (action === 'Open Claude Code Settings') {
                const settingsPath = configPaths.find(p => p.includes('.claude')) || configPaths[0];
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(settingsPath));
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to configure Claude: ${e.message}`);
        }
    }));

    // Command: write wolfbook MCP entry into Antigravity config
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.configureAntigravity', async () => {
        const bridgePath = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
        const nodeBin    = resolveNodeBinary();
        try {
            const { configPath } = writeAntigravityConfig(bridgePath, nodeBin);
            const { skillPath }  = installAntigravitySkill();
            const action = await vscode.window.showInformationMessage(
                `Antigravity configured ✓ (MCP: ${path.basename(configPath)}, Skill: ${path.basename(path.dirname(skillPath))}). Restart Antigravity to apply.`,
                'Open MCP Config', 'Open Skill File'
            );
            if (action === 'Open MCP Config') {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath));
            } else if (action === 'Open Skill File') {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(skillPath));
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to configure Antigravity: ${e.message}`);
        }
    }));

    // Command: write wolfbook MCP entry into Cline's settings file
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.configureCline', async () => {
        const bridgePath = path.join(context.extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js');
        const nodeBin    = resolveNodeBinary();
        try {
            const { updated, configPath, skipped } = writeClineConfig(bridgePath, nodeBin);
            if (skipped) {
                vscode.window.showWarningMessage(
                    'Cline does not appear to be installed (settings folder not found). ' +
                    'Install the Cline extension (saoudrizwan.claude-dev) and try again.'
                );
                return;
            }
            const action = await vscode.window.showInformationMessage(
                `Cline configured ✓ wolfbook MCP server entry written to cline_mcp_settings.json. Reload the VS Code window to apply.`,
                'Open Settings File', 'Reload Window'
            );
            if (action === 'Open Settings File') {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath));
            } else if (action === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to configure Cline: ${e.message}`);
        }
    }));
    ;
    // Update WBDirectory[] and NotebookDirectory[] whenever the active notebook changes
    function _updateKernelNotebookDir(ed) {
        if (!ed || ed.notebook?.notebookType !== 'extended-wolfram-notebook') return;
        if (controller.kernelStatusString !== 'resolved') return;
        let _nbDir = require('path').dirname(ed.notebook.uri.fsPath);
        if (process.platform === 'win32') _nbDir = _nbDir.replace(/\\/g, '/');
        const _esc = _nbDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        controller.session?.evaluate(
            `Unprotect[NotebookDirect.then(() => {
                if (controller.kernelStatusString === 'resolved') _debugCtrl.refreshLiveWatch();
            }).catch(() => {})ory, WBDirectory]; NotebookDirectory[] = "${_esc}"; Protect[NotebookDirectory]; WBDirectory[] = "${_esc}"; Protect[WBDirectory]`,
            { interactive: false }
        ).catch(() => {});
    }
    context.subscriptions.push(vscode_1.window.onDidChangeActiveNotebookEditor(ed => _updateKernelNotebookDir(ed)));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.launchKernel", () => {
        if (nbKernelenabled) {
            client.outputChannel.appendLine("Launching Wolfram Kernel");
            controller.launchKernel().then(() => {
                if (controller.kernelStatusString === 'resolved') _debugCtrl.refreshLiveWatch();
            }).catch(() => {});
        }
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.abortEvaluation", () => {
        // If a debug session is active, let it handle the abort — it exits Dialog[]
        // gracefully before aborting so the kernel is fully released.
        if (_debugCtrl.isActive) {
            _debugCtrl.stop();
        } else {
            controller.abortEvaluation();
        }
        // Always hard-reset all debugger flags so abort is the reliable last resort.
        // This catches stuck states even when debug wasn't "active" (e.g. _finishing
        // stuck true, _liveWatchInFlight stuck, stale _evalQueue promises).
        _debugCtrl.resetAllState();
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.openDialogSubsession", () => {
        controller.openDialogSubsession();
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.pasteImageCell", (args) => {
        controller.pasteImageAsCell(args || {});
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.pasteImageCellBelow", () => {
        controller.pasteImageAsCell({ insertBelow: true });
    }));
    // Auto-format status bar toggle — mirrors wolfbook.formatter.autoFormat setting.
    const _cfg = vscode.workspace.getConfiguration('wolfbook');
    let _autoFormatEnabled = _cfg.get('formatter.autoFormat', false);
    const _fmtStatusBar = vscode.window.createStatusBarItem(
        'wolfbook-auto-format', vscode.StatusBarAlignment.Right, 98
    );
    _fmtStatusBar.name = 'Wolfbook Auto Format';
    _fmtStatusBar.command = 'wolfbook.toggleAutoFormat';
    const _updateFmtStatusBar = () => {
        _fmtStatusBar.text    = _autoFormatEnabled ? '$(check) WL: Fmt' : '$(dash) WL: Fmt';
        _fmtStatusBar.tooltip = _autoFormatEnabled
            ? 'Auto-format on Enter: ON. Click to disable.'
            : 'Auto-format on Enter: OFF. Click to enable.';
    };
    _updateFmtStatusBar();
    _fmtStatusBar.hide(); // hidden until a wolfbook notebook is active
    context.subscriptions.push(_fmtStatusBar);
    context.subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(ed => {
        if (ed?.notebook?.notebookType === 'extended-wolfram-notebook') _fmtStatusBar.show();
        else _fmtStatusBar.hide();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.toggleAutoFormat', async () => {
        _autoFormatEnabled = !_autoFormatEnabled;
        await vscode.workspace.getConfiguration('wolfbook').update(
            'formatter.autoFormat', _autoFormatEnabled,
            vscode.ConfigurationTarget.Global
        );
        _updateFmtStatusBar();
    }));
    // Keep toggleAutoEditMode registered (no-op) in case keybinding survives in user settings
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.toggleAutoEditMode', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.insertCellAbove', async () => {
        await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
        await new Promise(r => setTimeout(r, 80));
        // VS Code may have auto-entered edit mode after insert — don't toggle it off.
        if (!vscode.window.activeTextEditor) {
            await vscode.commands.executeCommand('notebook.cell.edit');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.insertCellBelow', async () => {
        await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
        await new Promise(r => setTimeout(r, 80));
        // VS Code may have auto-entered edit mode after insert — don't toggle it off.
        if (!vscode.window.activeTextEditor) {
            await vscode.commands.executeCommand('notebook.cell.edit');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.deleteActiveCell', async () => {
        await vscode.commands.executeCommand('notebook.cell.delete');
        await new Promise(r => setTimeout(r, 50));
        await vscode.commands.executeCommand('notebook.cell.edit');
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.restartKernel", () => {
        // Hard-reset all debugger state before restarting kernel
        _debugCtrl.resetAllState();
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
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.executeCell", async () => {
        scrollLog('[scroll] Shift+Enter detected — evaluation triggered, waiting for first output');

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

        // ---- Save viewport + selection for refine-mode scroll guard ----
        // Saved NOW — before ANY execution-related scroll can fire.
        // The scroll guard in scroll/manager.js restores these at Idle.
        controller._scrollGuardSavedViewport   = editor.visibleRanges[0] || null;
        controller._scrollGuardSavedSelections = [...editor.selections];
        scrollLog('[executeCell] viewport saved: start',
            controller._scrollGuardSavedViewport?.start,
            '| selections:', controller._scrollGuardSavedSelections.map(r => r.start + '-' + r.end).join(', '));

        // ---- Mode detection (read-only, no side-effects) ----
        // Mirrors controller.execute() logic so we can pre-empt for advance mode.
        const _cellUri    = cell.document.uri.toString();
        const _curSrc     = cell.document.getText();
        const _lastSrc    = controller._cellLastSource.get(_cellUri);
        const _srcChanged = (_lastSrc !== undefined && _lastSrc !== _curSrc)
                         || (_lastSrc === undefined  && controller._cellDirty.has(_cellUri));
        const _autoMode   = _srcChanged ? 'refine' : 'advance';
        const _preMode    = (controller._evalModeOverride !== 'auto')
                          ? controller._evalModeOverride : _autoMode;

        // ---- PRE-EMPT scroll for advance mode only ----
        // Advance: AtTop — pin cell at top immediately so output fills in below.
        // Refine: NO pre-empt — the scroll guard handles everything at Idle.
        if (_preMode !== 'refine') {
            const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
            const _preRange = new RC(cell.index, cell.index + 1);
            editor.revealRange(_preRange, vscode.NotebookEditorRevealType.AtTop);
            scrollLog('[executeCell-preempt] advance: AtTop cell', cell.index);
        } else {
            scrollLog('[executeCell-preempt] refine: no pre-empt (scroll guard handles it)');
        }

        // Note: markKeyboardExecution is intentionally NOT called here.
        // execute() determines the eval mode (Advance vs Refine) from cell
        // source history and calls markKeyboardExecution internally with the
        // correct mode. Mode detection above is read-only (no side-effects).

        // Stop any active debug session FIRST — the kernel must be free of Dialog[]
        // before execute() queues the cell, otherwise the cell never runs.
        if (_debugCtrl.isActive) {
            await _debugCtrl.stop();
            // Short settle so the kernel finishes processing the abort.
            await new Promise(r => setTimeout(r, 200));
        }

        controller._wolframExecPending = true;
        controller.execute([cell], editor.notebook, controller._controller);
    }));

    // Eval mode toggle commands — cycle: auto → advance → refine → auto
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.evalMode.auto", () => {
        controller.setEvalMode('advance');  // auto was active → switch to advance
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.evalMode.advance", () => {
        controller.setEvalMode('refine');   // advance was active → switch to refine
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.evalMode.refine", () => {
        controller.setEvalMode('auto');     // refine was active → reset to auto
    }));

    // Format switching commands
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.setOutputFormatImage", async () => {
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Setting output format to Image');
        await configCompat.updateSetting('notebook.rendering.outputFormat', 'Image', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to Image (PNG)');
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Config updated, current value:', configCompat.getSetting('notebook.rendering.outputFormat'));
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.setOutputFormatHTML", async () => {
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Setting output format to HTML');
        await configCompat.updateSetting('notebook.rendering.outputFormat', 'HTML', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to HTML');
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Config updated, current value:', configCompat.getSetting('notebook.rendering.outputFormat'));
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.setOutputFormatMathML", async () => {
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Setting output format to MathML');
        await configCompat.updateSetting('notebook.rendering.outputFormat', 'MathML', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to MathML');
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Config updated, current value:', configCompat.getSetting('notebook.rendering.outputFormat'));
    }));
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.setOutputFormatInputForm", async () => {
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Setting output format to InputForm');
        await configCompat.updateSetting('notebook.rendering.outputFormat', 'InputForm', vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('Output format set to InputForm');
        console.log('[Extension] Config updated, current value:', configCompat.getSetting('notebook.rendering.outputFormat'));
    }));
    
    // Clear cell output command
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.clearCellOutput", async (cell) => {
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Clear cell output command triggered');
        
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
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Cell output cleared');
    }));
    
    // Expand truncated output command
    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.expandTruncatedOutput", async (args) => {
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] ========================================');
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Expand truncated output command triggered!');
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Args received:', JSON.stringify(args));
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] Args type:', typeof args);
        
        // Extract UUID from command arguments (if provided) or fall back to last truncated
        let uuid = null;
        
        if (args && args.uuid) {
            // UUID passed from command: URI link
            uuid = args.uuid;
            devLog(LOG_CHANNELS.EXTENSION, '[Extension] Using UUID from command args:', uuid);
        } else if (controller.lastTruncatedExecution && controller.lastTruncatedExecution.truncatedOutputId) {
            // Fallback to stored UUID (for toolbar button)
            uuid = controller.lastTruncatedExecution.truncatedOutputId;
            devLog(LOG_CHANNELS.EXTENSION, '[Extension] Using UUID from lastTruncatedExecution:', uuid);
        } else {
            devLog(LOG_CHANNELS.EXTENSION, '[Extension] No UUID available!');
        }
        
        if (uuid) {
            devLog(LOG_CHANNELS.EXTENSION, '[Extension] Sending expand-output message to kernel with UUID:', uuid);
            controller.postMessageToKernel({
                type: "expand-output",
                uuid: uuid
            });
            
            vscode.window.showInformationMessage('Requesting full output...');
        } else {
            devLog(LOG_CHANNELS.EXTENSION, '[Extension] WARNING: No truncated output to expand');
            vscode.window.showWarningMessage('No truncated output to expand');
        }
        devLog(LOG_CHANNELS.EXTENSION, '[Extension] ==============================');
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

    // wolfram.navLeft / wolfram.navRight (command mode — NOT in cell edit mode)
    // Left:  enter the nearest code cell ABOVE the current selection, cursor at END.
    // Right: enter the nearest code cell BELOW the current selection, cursor at START.
    //        If no code cell exists below — create one and start editing.
    //
    // Bounce-back: if the user just exited a cell via cursorDown (last line → Down key)
    // and immediately presses Up, re-enter the SAME cell with cursor at end of last line.
    // Symmetrically, exit via cursorUp + immediately Down → same cell, cursor at start.
    const BOUNCE_BACK_MS = 1000;
    let _lastArrowExit = null;  // { time, direction: 'up'|'down', cellIndex }

    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.navLeft', async () => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) return;
        const nb       = editor.notebook;
        const selStart = editor.selection.start;

        // Bounce-back (← key): re-enter the cell we just left via Down arrow, cursor at END of last line.
        if (_lastArrowExit && _lastArrowExit.direction === 'down' &&
            Date.now() - _lastArrowExit.time < BOUNCE_BACK_MS &&
            _lastArrowExit.cellIndex >= 0 && _lastArrowExit.cellIndex < nb.cellCount) {
            const idx = _lastArrowExit.cellIndex;
            _lastArrowExit = null;
            const cell = nb.cellAt(idx);
            if (cell && cell.kind === vscode.NotebookCellKind.Code) {
                editor.selection = new vscode.NotebookRange(idx, idx + 1);
                await vscode.commands.executeCommand('notebook.cell.edit');
                const txtEditor = vscode.window.activeTextEditor;
                if (txtEditor) {
                    const lastLine = txtEditor.document.lineCount - 1;
                    const endPos   = new vscode.Position(lastLine, txtEditor.document.lineAt(lastLine).text.length);
                    txtEditor.selection = new vscode.Selection(endPos, endPos);
                }
                return;
            }
        }
        _lastArrowExit = null;

        // Walk upward to find the nearest code cell above the selection.
        for (let i = selStart - 1; i >= 0; i--) {
            const cell = nb.cellAt(i);
            if (cell.kind === vscode.NotebookCellKind.Code) {
                // Select the target cell in the notebook.
                editor.selection = new vscode.NotebookRange(i, i + 1);
                // Enter edit mode.
                await vscode.commands.executeCommand('notebook.cell.edit');
                // Move cursor to the very end of the cell text.
                const txtEditor = vscode.window.activeTextEditor;
                if (txtEditor) {
                    const lastLine = txtEditor.document.lineCount - 1;
                    const endPos   = new vscode.Position(lastLine, txtEditor.document.lineAt(lastLine).text.length);
                    txtEditor.selection = new vscode.Selection(endPos, endPos);
                }
                return;
            }
        }
        // No code cell above — fall through to built-in notebook navigation.
        await vscode.commands.executeCommand('notebook.focusPreviousCell');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.navRight', async () => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) return;
        const nb      = editor.notebook;
        const selEnd  = editor.selection.end;  // exclusive end of selection range

        // Bounce-back: re-enter the cell we just left via Up arrow.
        if (_lastArrowExit && _lastArrowExit.direction === 'up' &&
            Date.now() - _lastArrowExit.time < BOUNCE_BACK_MS &&
            _lastArrowExit.cellIndex >= 0 && _lastArrowExit.cellIndex < nb.cellCount) {
            const idx = _lastArrowExit.cellIndex;
            _lastArrowExit = null;
            const cell = nb.cellAt(idx);
            if (cell && cell.kind === vscode.NotebookCellKind.Code) {
                editor.selection = new vscode.NotebookRange(idx, idx + 1);
                await vscode.commands.executeCommand('notebook.cell.edit');
                const txtEditor = vscode.window.activeTextEditor;
                if (txtEditor) {
                    const startPos = new vscode.Position(0, 0);
                    txtEditor.selection = new vscode.Selection(startPos, startPos);
                }
                return;
            }
        }
        _lastArrowExit = null;

        // Walk downward to find the nearest code cell below (after) the selection.
        for (let i = selEnd; i < nb.cellCount; i++) {
            const cell = nb.cellAt(i);
            if (cell.kind === vscode.NotebookCellKind.Code) {
                editor.selection = new vscode.NotebookRange(i, i + 1);
                await vscode.commands.executeCommand('notebook.cell.edit');
                // Move cursor to the very start.
                const txtEditor = vscode.window.activeTextEditor;
                if (txtEditor) {
                    const startPos = new vscode.Position(0, 0);
                    txtEditor.selection = new vscode.Selection(startPos, startPos);
                }
                return;
            }
        }
        // No code cell below — insert a new one at the bottom and start editing.
        await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
        await vscode.commands.executeCommand('notebook.cell.edit');
    }));

    // wolfbook.navUp — ↑ key in nav mode.
    // Bounce-back (↑ after down-exit): re-enter the same cell, cursor at BEGINNING of last line.
    // Normal: walk upward to the nearest code cell, cursor at end (same as navLeft).
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.navUp', async () => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) return;
        const nb       = editor.notebook;
        const selStart = editor.selection.start;

        // Bounce-back (↑ after down-exit): cursor at BEGINNING of last line.
        if (_lastArrowExit && _lastArrowExit.direction === 'down' &&
            Date.now() - _lastArrowExit.time < BOUNCE_BACK_MS &&
            _lastArrowExit.cellIndex >= 0 && _lastArrowExit.cellIndex < nb.cellCount) {
            const idx = _lastArrowExit.cellIndex;
            _lastArrowExit = null;
            const cell = nb.cellAt(idx);
            if (cell && cell.kind === vscode.NotebookCellKind.Code) {
                editor.selection = new vscode.NotebookRange(idx, idx + 1);
                await vscode.commands.executeCommand('notebook.cell.edit');
                const txtEditor = vscode.window.activeTextEditor;
                if (txtEditor) {
                    const lastLine = txtEditor.document.lineCount - 1;
                    const startOfLast = new vscode.Position(lastLine, 0);
                    txtEditor.selection = new vscode.Selection(startOfLast, startOfLast);
                }
                return;
            }
        }
        _lastArrowExit = null;

        // Walk upward to find the nearest code cell above the selection.
        for (let i = selStart - 1; i >= 0; i--) {
            const cell = nb.cellAt(i);
            if (cell.kind === vscode.NotebookCellKind.Code) {
                editor.selection = new vscode.NotebookRange(i, i + 1);
                await vscode.commands.executeCommand('notebook.cell.edit');
                const txtEditor = vscode.window.activeTextEditor;
                if (txtEditor) {
                    const lastLine = txtEditor.document.lineCount - 1;
                    const endPos   = new vscode.Position(lastLine, txtEditor.document.lineAt(lastLine).text.length);
                    txtEditor.selection = new vscode.Selection(endPos, endPos);
                }
                return;
            }
        }
        await vscode.commands.executeCommand('notebook.focusPreviousCell');
    }));

    // wolfram.cursorLeft / cursorRight / cursorUp / cursorDown
    // At cell boundaries, an isolated key press exits edit mode (like Escape).
    // A repeated press (user holding the key) is treated as auto-repeat and
    // simply moves the cursor — so navigating through code with a held key
    // never accidentally pops out of the cell.
    // Auto-repeat threshold: macOS fires at ~30 Hz (33 ms); human taps are >150 ms apart.
    const ARROW_REPEAT_MS = 120;
    let lastLeftTime  = 0;
    let lastRightTime = 0;
    let lastUpTime    = 0;
    let lastDownTime  = 0;

    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.cursorLeft', async () => {
        const now = Date.now();
        const isRepeat = (now - lastLeftTime) < ARROW_REPEAT_MS;
        lastLeftTime = now;
        const editor = vscode.window.activeTextEditor;
        if (!isRepeat && editor && editor.selection.isEmpty) {
            const pos = editor.selection.active;
            if (pos.line === 0 && pos.character === 0) {
                await vscode.commands.executeCommand('notebook.cell.quitEdit');
                return;
            }
        }
        await vscode.commands.executeCommand('cursorLeft');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.cursorRight', async () => {
        const now = Date.now();
        const isRepeat = (now - lastRightTime) < ARROW_REPEAT_MS;
        lastRightTime = now;
        const editor = vscode.window.activeTextEditor;
        if (!isRepeat && editor && editor.selection.isEmpty) {
            const pos  = editor.selection.active;
            const last = editor.document.lineCount - 1;
            if (pos.line === last && pos.character === editor.document.lineAt(last).text.length) {
                await vscode.commands.executeCommand('notebook.cell.quitEdit');
                return;
            }
        }
        await vscode.commands.executeCommand('cursorRight');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.cursorUp', async () => {
        const now = Date.now();
        const isRepeat = (now - lastUpTime) < ARROW_REPEAT_MS;
        lastUpTime = now;
        const editor = vscode.window.activeTextEditor;
        if (!isRepeat && editor && editor.selection.isEmpty) {
            if (editor.selection.active.line === 0) {
                // Record exit so navRight can bounce back into this cell.
                const nbEd = vscode.window.activeNotebookEditor;
                _lastArrowExit = { time: Date.now(), direction: 'up', cellIndex: nbEd ? nbEd.selection.start : -1 };
                await vscode.commands.executeCommand('notebook.cell.quitEdit');
                return;
            }
        }
        await vscode.commands.executeCommand('cursorUp');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.cursorDown', async () => {
        const now = Date.now();
        const isRepeat = (now - lastDownTime) < ARROW_REPEAT_MS;
        lastDownTime = now;
        const editor = vscode.window.activeTextEditor;
        if (!isRepeat && editor && editor.selection.isEmpty) {
            const last = editor.document.lineCount - 1;
            if (editor.selection.active.line === last) {
                // Record exit so navLeft can bounce back into this cell.
                const nbEd = vscode.window.activeNotebookEditor;
                _lastArrowExit = { time: Date.now(), direction: 'down', cellIndex: nbEd ? nbEd.selection.start : -1 };
                await vscode.commands.executeCommand('notebook.cell.quitEdit');
                return;
            }
        }
        await vscode.commands.executeCommand('cursorDown');
    }));

    // Hover doc expand command: triggered when user clicks the 📖 stub in a hover.
    // Sends raw Markdown to the Watch panel webview; marked+KaTeX renders it there.
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.expandHoverDoc', async (cacheKey) => {
        if (!cacheKey) return;
        // Extract fallback Markdown from LSP cache (used only when kernel is off)
        const cached = _hoverDocCache.get(cacheKey);
        let fallbackMd = null;
        if (cached) {
            const parts = Array.isArray(cached.contents) ? cached.contents : [cached.contents];
            fallbackMd = parts.map(c =>
                typeof c === 'string' ? c
                : (c && typeof c === 'object' && 'value' in c) ? c.value
                : ''
            ).filter(Boolean).join('\n\n---\n\n');
        }
        // Focus the watch panel first
        try { await vscode.commands.executeCommand('wolfbook.watchPanel.focus'); } catch(_) {}
        // Use same eval-sel pipeline: kernel → BTL render → evalSelUpdate
        // Works for built-in AND user-defined symbols; falls back to LSP Markdown if kernel is off
        await evalSel.docLookup(controller, cacheKey, _watchPanel, fallbackMd);
    }));

    // Setup Escape Mode (Esc key for Mathematica-style aliases)
    (0, escape_mode_1.registerEscapeMode)(context, extensionPath);
    devLog(LOG_CHANNELS.EXTENSION, '[Extension] Escape mode registered');

    // Setup SmartSelect / Expand Selection for Wolfram Language
    require('./editor/selectionRange').register(context);
    devLog(LOG_CHANNELS.EXTENSION, '[Extension] Selection range provider registered');

    // Setup bracket-based code folding for Wolfram Language
    require('./editor/folding').register(context);
    devLog(LOG_CHANNELS.EXTENSION, '[Extension] Folding range provider registered');

    // Setup refine-mode scroll guard: pins viewport to evaluated cell during
    // streaming output, cancelling VS Code's internal appendOutput-triggered scrolls.
    _scrollMgr.registerExecutionScrollGuard(context, () => controller);
    devLog(LOG_CHANNELS.EXTENSION, '[Extension] Execution scroll guard registered');

    // Setup Notebook Settings — already registered early above

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
            vscode.commands.registerCommand('wolfbook.registerFileTypes', _runFileAssoc)
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
    // Popular Wolfram Language functions for completion priority sorting.
    // Items in this set appear before alphabetical results.
    const _wolframPopularFunctions = new Set([
        'Table', 'Do', 'For', 'While', 'If', 'Which', 'Switch', 'Module', 'Block', 'With',
        'Map', 'Apply', 'Select', 'Cases', 'Fold', 'FoldList', 'Nest', 'NestList', 'Thread',
        'Print', 'Echo', 'StringJoin', 'StringReplace', 'StringCases', 'StringSplit',
        'ToString', 'ToExpression', 'InputForm', 'FullForm',
        'Plot', 'ListPlot', 'Plot3D', 'ListLinePlot', 'Show', 'Graphics', 'GraphicsComplex',
        'Solve', 'NSolve', 'DSolve', 'NDSolve', 'Reduce', 'Simplify', 'FullSimplify',
        'Series', 'Normal', 'Coefficient', 'CoefficientList', 'Expand', 'Factor', 'Apart',
        'Integrate', 'NIntegrate', 'D', 'Dt', 'Limit', 'Sum', 'Product',
        'Replace', 'ReplaceAll', 'ReplaceRepeated', 'Rule', 'RuleDelayed',
        'List', 'Association', 'Append', 'Prepend', 'Join', 'Flatten', 'Part', 'Take', 'Drop',
        'Length', 'Dimensions', 'Range', 'ConstantArray', 'Array', 'SparseArray',
        'Sort', 'SortBy', 'Reverse', 'Position', 'MemberQ', 'FreeQ', 'Count',
        'Plus', 'Times', 'Power', 'Sqrt', 'Log', 'Exp', 'Sin', 'Cos', 'Tan',
        'Abs', 'Re', 'Im', 'Conjugate', 'Arg',
        'MatrixForm', 'Transpose', 'Inverse', 'Det', 'Dot', 'Cross', 'Eigenvalues', 'Eigenvectors',
        'LinearSolve', 'SingularValueDecomposition',
        'Set', 'SetDelayed', 'Clear', 'ClearAll', 'Remove',
        'True', 'False', 'None', 'Null', 'Infinity', 'All', 'Automatic',
        'Function', 'Slot', 'SlotSequence', 'Return', 'Break', 'Continue', 'Throw', 'Catch',
        'Head', 'MatchQ', 'Pattern', 'Blank', 'BlankSequence', 'BlankNullSequence',
        'Quiet', 'Check', 'AbsoluteTime', 'AbsoluteTiming', 'Timing',
        'Export', 'Import', 'Put', 'Get', 'ReadList', 'Read', 'Write',
        'Names', 'Context', 'Contexts', 'Begin', 'End', 'BeginPackage', 'EndPackage',
        'Manipulate', 'Dynamic', 'DynamicModule', 'Slider', 'Button',
        'Row', 'Column', 'Grid', 'Panel', 'Pane', 'Style', 'Text',
        'Labeled', 'Tooltip', 'Framed', 'Item',
        'ParallelMap', 'ParallelTable', 'ParallelDo',
        'FindRoot', 'NMinimize', 'NMaximize', 'FindMinimum', 'FindMaximum',
        'Interpolation', 'Fit', 'FindFit', 'LinearModelFit',
        'DownValues', 'OwnValues', 'SubValues', 'UpValues', 'Attributes',
        'Hold', 'HoldForm', 'Evaluate', 'ReleaseHold', 'Unevaluated',
        'Condition', 'PatternTest', 'Alternatives',
        'StringForm', 'TemplateApply', 'FileNameJoin', 'DirectoryName',
        'DateString', 'Now', 'Pause',
        'Keys', 'Values', 'Lookup', 'AssociationThread', 'Merge', 'KeySort',
        'GroupBy', 'Counts', 'Tally', 'DeleteDuplicates', 'Union', 'Intersection', 'Complement',
        'Piecewise', 'Boole', 'UnitStep', 'HeavisideTheta',
        'Assuming', 'Refine', '$Assumptions',
        'N', 'Rationalize', 'Round', 'Floor', 'Ceiling', 'IntegerPart', 'FractionalPart',
        'Mod', 'Quotient', 'GCD', 'LCM', 'FactorInteger', 'PrimeQ',
        'RandomReal', 'RandomInteger', 'RandomChoice', 'SeedRandom',
        'Partition', 'Riffle', 'Transpose', 'MapThread', 'MapIndexed',
        'Total', 'Mean', 'Median', 'Variance', 'StandardDeviation',
        'Max', 'Min', 'MinMax', 'Ordering', 'TakeLargest', 'TakeSmallest',
    ]);

    let enabled = config.get("lsp.serverEnabled", true);
    if (!enabled) {
        return;
    }
    // Resolve the LSP kernel separately: the WSTP kernel may be the Wolfram Engine
    // Player which doesn't support stdio mode. resolveLSPKernel() falls back to
    // the first stdio-capable kernel found on this machine (e.g. Wolfram 3.app).
    const lspKernel = extensionKernel.resolveLSPKernel();
    let lspcommand = config.get("advanced.lsp.command", ["lspKernel"]);
    let lspLog = config.get("advanced.lsp.ServerLogDirectory", "Off");
    // Set lspcommand to use standalone LSP app.
    // Use the default option to launch LSPServer
    if (lspcommand[0] == "lspKernel") {
        // No log directory is to be used
        if (lspLog == "Off") {
            lspcommand = [
                lspKernel,
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
                lspKernel,
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
        },
        // Filter noisy LSP diagnostics before VS Code ever sees them.
        middleware: {
            // Wolfram's ReadRawJSONString crashes on UTF-16 surrogate pairs
            // (supplementary-plane chars like 𝕊 U+1D54A).  Replace them with
            // \[WolframName] escapes so the LSP sees valid WL, not surrogates.
            didOpen(document, next) {
                const text = document.getText();
                const safe = wlSanitizeForLSP(text);
                if (safe !== text) {
                    return next({
                        uri: document.uri,
                        languageId: document.languageId,
                        version: document.version,
                        fileName: document.fileName,
                        isUntitled: document.isUntitled,
                        isDirty: document.isDirty,
                        isClosed: document.isClosed,
                        eol: document.eol,
                        lineCount: document.lineCount,
                        getText: () => safe,
                        getWordRangeAtPosition: (...a) => document.getWordRangeAtPosition(...a),
                        lineAt: (...a) => document.lineAt(...a),
                        offsetAt: (...a) => document.offsetAt(...a),
                        positionAt: (...a) => document.positionAt(...a),
                        validateRange: (...a) => document.validateRange(...a),
                        validatePosition: (...a) => document.validatePosition(...a),
                    });
                }
                return next(document);
            },
            didChange(event, next) {
                if (event.contentChanges.some(c => c.text !== wlSanitizeForLSP(c.text))) {
                    const sanitized = Object.assign({}, event, {
                        contentChanges: event.contentChanges.map(c => {
                            const s = wlSanitizeForLSP(c.text);
                            return s !== c.text ? Object.assign({}, c, { text: s }) : c;
                        })
                    });
                    return next(sanitized);
                }
                return next(event);
            },
            handleDiagnostics(uri, diagnostics, next) {
                const doc = vscode_1.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                const filtered = diagnostics.filter((diag) => {
                    const msg = diag.message;
                    if (msg.toLowerCase().includes('unexpected expression at top-level')) return false;
                    if (msg.includes('Suspicious use of') && msg.includes('session symbol')) return false;
                    if (msg.includes('Suspicious uppercase') && msg.includes('pattern')) return false;
                    if (msg.includes('Operands') && msg.includes('different lines')) return false;
                    if (/expected.*operand/i.test(msg)) return false;
                    if (msg.includes('Non-ASCII character')) return false;
                    if (msg.includes('letterlike') || msg.includes('Unexpected character') ||
                        msg.includes('unexpected character') || msg.includes('Unknown character')) {
                        if (doc) {
                            const text = doc.getText(diag.range);
                            if (text && /[^\x00-\x7F]/.test(text)) return false;
                        }
                    }
                    // Suppress any diagnostic whose range contains ONLY non-ASCII characters
                    if (doc) {
                        const text = doc.getText(diag.range);
                        if (text && /^[^\x00-\x7F]+$/.test(text)) return false;
                    }
                    return true;
                });
                next(uri, filtered);
            },
            // Completion middleware: suppress auto-triggered LSP completions so the
            // dropdown doesn't steal arrow keys.  Only show LSP completions when
            // explicitly invoked (Ctrl+Space / Cmd+Space) or on trigger characters.
            // When shown, re-sort by approximate function popularity.
            async provideCompletionItem(document, position, context, token, next) {
                // vscode.CompletionTriggerKind: 0=Invoke, 1=TriggerCharacter, 2=TriggerForIncompleteCompletions
                if (context.triggerKind !== 0 && context.triggerKind !== 1) {
                    // Auto-triggered (typing): require at least 3 chars of the current word
                    const line = document.lineAt(position.line).text;
                    const before = line.slice(0, position.character);
                    const wordMatch = before.match(/[A-Za-z$][A-Za-z0-9$]*$/);
                    if (!wordMatch || wordMatch[0].length < 3) {
                        return undefined;
                    }
                }
                const result = await next(document, position, context, token);
                if (!result) return result;
                // Re-sort by popularity: items in the top-tier list get sortText '0...',
                // others get '1...' so VS Code orders popular items first.
                const items = Array.isArray(result) ? result : (result.items || result);
                if (Array.isArray(items)) {
                    const popSet = _wolframPopularFunctions;
                    for (const it of items) {
                        const label = typeof it.label === 'string' ? it.label : it.label?.label;
                        if (label && popSet.has(label)) {
                            it.sortText = '0' + (it.sortText || label);
                        } else {
                            it.sortText = '1' + (it.sortText || label || '');
                        }
                    }
                }
                return result;
            },
            // Hover middleware: two-phase hover.
            // Phase 1: immediately return a stub with only a 📖 book-icon link.
            // Phase 2: when user clicks 📖, the expandHoverDoc command sets the
            //   cache key in _hoverExpandSet and re-triggers showHover; this call
            //   then returns the full cached LSP content.
            async provideHover(document, position, token, next) {
                const hover = await next(document, position, token);
                if (!hover) return hover;

                // Suppress the LSP "No function information." placeholder
                const contents = hover.contents;
                const texts = Array.isArray(contents) ? contents : [contents];
                const allEmpty = texts.every(c => {
                    const val = typeof c === 'string' ? c
                              : (c && typeof c === 'object' && 'value' in c) ? c.value
                              : '';
                    return !val || val.trim() === '' || /^No function information\.?$/i.test(val.trim());
                });
                if (allEmpty) return null;

                // Cache the hover keyed by docUri|symbolName (cap at 300 entries)
                const wordRange = document.getWordRangeAtPosition(
                    position,
                    /[A-Za-z$\u00C0-\u024F\u0370-\u03FF\u1E00-\u1EFF][A-Za-z0-9$\u00C0-\u024F\u0370-\u03FF\u1E00-\u1EFF]*/
                );
                const word = wordRange ? document.getText(wordRange) : null;
                // Key by symbol name only — Wolfram docs don't vary by file,
                // and the notebook cell URI fragment changes between hover and click.
                const cacheKey = word || `${position.line}:${position.character}`;
                _hoverDocCache.set(cacheKey, hover);
                if (_hoverDocCache.size > 300) {
                    _hoverDocCache.delete(_hoverDocCache.keys().next().value);
                }

                // Return stub: clickable 📖 that shows full doc in the Watch panel
                const cmdArg = encodeURIComponent(JSON.stringify([cacheKey]));
                const md = new vscode.MarkdownString(
                    `[📖](command:wolfbook.expandHoverDoc?${cmdArg})`
                );
                md.isTrusted = { enabledCommands: ['wolfbook.expandHoverDoc'] };
                return new vscode.Hover(md);
            }
        }
    };
    client = new node_1.LanguageClient('wolfram', 'Wolfram-LSP', serverOptions, clientOptions);
    
    // The primary filter is in clientOptions.middleware.handleDiagnostics above.
    // This secondary hook catches any diagnostics that slip through via other
    // VS Code language-client code paths (e.g. pull-diagnostics in newer clients).
    client.onDidChangeState((event) => {
        if (event.newState === 2) { // Running state
            if (!client.diagnostics?.onDidChangeDiagnostics) return;
            client.diagnostics.onDidChangeDiagnostics((event) => {
                event.uris.forEach((uri) => {
                    const diagnostics = client.diagnostics.get(uri);
                    if (!diagnostics || diagnostics.length === 0) return;
                    const doc = vscode_1.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                    const filtered = diagnostics.filter((diag) => {
                        const msg = diag.message;
                        if (msg.toLowerCase().includes('unexpected expression at top-level')) return false;
                        if (msg.includes('Suspicious use of') && msg.includes('session symbol')) return false;
                        if (msg.includes('Suspicious uppercase') && msg.includes('pattern')) return false;
                        if (msg.includes('Operands') && msg.includes('different lines')) return false;
                        if (/expected.*operand/i.test(msg)) return false;
                        if (msg.includes('Non-ASCII character')) return false;
                        // Suppress any diagnostic whose range contains ONLY non-ASCII characters
                        // (these are our \[Name] → Unicode replacements — fully valid WL).
                        if (doc) {
                            const text = doc.getText(diag.range);
                            if (text && /^[^\x00-\x7F]+$/.test(text)) return false;
                        }
                        // Legacy: suppress explicit "Unexpected/Unknown character" LSP messages
                        // on ranges that contain non-ASCII text.
                        if (msg.includes('letterlike') ||
                            msg.includes('Unexpected character') ||
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

    // Register the .wslide custom editor provider
    const slideEditorProvider_1 = require('./slideEditorProvider');
    const slideProvider = new slideEditorProvider_1.SlideEditorProvider(context);
    slideProvider.setGetController(() => controller);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'wolfbook.slideEditor',
            slideProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    // Dismiss the loading indicator now that activation is complete
    clearTimeout(_loadingTimeout);
    _dismissLoading();
}
exports.activate = activate;

/**
 * Called by VS Code when the extension is deactivated (window reload, disable, uninstall).
 * Ensures the Wolfram kernel process is terminated cleanly so no orphan processes
 * are left running after a window reload.
 */
function deactivate() {
    if (_activeController) {
        try { _activeController.quitKernel(); } catch(_) {}
        _activeController = null;
    }
}
exports.deactivate = deactivate;

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