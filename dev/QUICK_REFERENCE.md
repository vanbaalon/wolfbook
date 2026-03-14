# Wolfbook Quick Reference

## File Locations

| File | Purpose |
|------|---------|
| out/extension/controller.js | Kernel controller, main logic |
| out/extension/extension.js | Activation, LSP client, commands |
| out/extension/debugger/watchPanel.js | Watch Panel provider (state, messaging) |
| out/extension/debugger/watchPanel.webview.js | Watch Panel webview script (UI, syntax check) |
| out/extension/editor/evaluateSelection.js | Cmd+Shift+E eval-sel + Cmd+Shift+W add-to-watch |
| out/client/index-with-messaging.js | Notebook renderer webview |
| resources/init.wl | Kernel init (output rendering, truncation) |
| package.json | Manifest (commands, settings, themes) |

Active install: ~/.vscode/extensions/wolfbook.wolfbook-2.2.0/

---

## Quick Deploy (no repackage)

```
cd /Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension
./deploy-extension.sh quick
```

Then: Cmd+Shift+P → Developer: Reload Window

---

## Keyboard Shortcuts

| Shortcut | Command | When |
|----------|---------|------|
| `Shift+Enter` | Evaluate cell | Notebook focused |
| `Cmd+Shift+D` | Debug cell | Notebook focused, not in debug |
| `F10` | Step Over | Debug active |
| `F11` | Step Into | Debug active |
| `⇧F11` | Step Out | Debug active |
| `F5` | Continue to Breakpoint | Debug active |
| `Ctrl+F5` | Run to End | Debug active |
| `⇧F5` | Stop debug | Debug active |
| `F9` | Toggle Breakpoint | Notebook focused |
| `Cmd+Shift+E` | Evaluate Selection | Editor focused in wolfram notebook |
| `Cmd+Shift+W` | Add Selection to Watch | Editor focused in wolfram notebook |

---

## Key Sections in controller.js

| Feature | Approximate location |
|---------|----------------------|
| launchKernel() | Kernel start, init.wl load |
| abortEvaluation() | Sends WSAbortMessage |
| restartKernel() | Increment _sessionEpoch, re-launch |
| expandTruncatedOutput | Sends expand-output to kernel |

## Key Sections in extension.js

| Feature | Approximate location |
|---------|----------------------|
| activate() | Extension entry, command registration |
| filterDiagnostics() | Suppresses spurious LSP warnings |
| autoReplaceUnicode | \[Name] -> unicode replacement |
| evalSel.register() | Registers eval-sel + add-to-watch commands |

## Key Sections in watchPanel.js

| Feature | Approximate location |
|---------|----------------------|
| WatchPanelProvider constructor | State init, localResourceRoots |
| resolveWebviewView() | onDidReceiveMessage handler |
| addWatchExternal(name) | Programmatic add-to-watch (Cmd+Shift+W path) |
| evalSelResult() / evalSelSpinner() | Post eval-sel result/spinner to webview |
| setDebugActive(active) | Toggle debug mode, send to webview |

## Key Sections in evaluateSelection.js

| Feature | Approximate location |
|---------|----------------------|
| evaluateSelection() | Main entry: get selection, guard debug, send to kernel |
| _renderResult() | HTML truncation (>60 KB → temp file + link) |
| _validateWLSyntax() | Bracket/string balance checker |
| addSelectionToWatch() | Cmd+Shift+W: validate + addWatchExternal |
| register() | Registers all three commands + status bar |

## Key Sections in index-with-messaging.js

| Feature | Approximate location |
|---------|----------------------|
| wl-output-header listener | Adds Wrap button to every output |
| Wrap button style | margin-left:auto (right-aligned) |
| Dialog widget | openDialogWidget() |

---

## Kernel Log

Kernel output is logged via `scrollLog()` from `out/extension/utils/dev-logger.js`.
Search VS Code Output panel → "Wolfbook" channel at runtime.

## Build & Publish

```
./deploy-extension.sh quick    # file-copy deploy (no VSIX)
./deploy-extension.sh          # full VSIX repackage + deploy
```

Last Updated: March 2026
