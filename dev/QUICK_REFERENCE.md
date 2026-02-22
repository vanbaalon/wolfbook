# Wolfbook Quick Reference

## File Locations

| File | Purpose |
|------|---------|
| out/extension/controller.js | Kernel controller, main logic |
| out/extension/extension.js | Activation, LSP client, commands |
| out/client/index-with-messaging.js | Notebook renderer webview |
| resources/init.wl | Kernel init (output rendering, truncation) |
| package.json | Manifest (commands, settings, themes) |

Active install: ~/.vscode/extensions/wolfbook.wolfbook-2.0.0/

---

## Quick Deploy (no repackage)


Then: Cmd+Shift+P -> Developer: Reload Window

---

## Key Sections in controller.js

| Feature | Approximate location |
|---------|----------------------|
| checkoutExecutionQueue | ZMQ receive loop |
| abortEvaluation | Abort without output or notification |
| restartKernel | Restart without notification |
| wl-output-header HTML | Out[N]= label row, includes width:100% |
| expandTruncatedOutput | Sends expand-output to kernel |

## Key Sections in extension.js

| Feature | Approximate location |
|---------|----------------------|
| activate() | Extension entry, command registration |
| filterDiagnostics() | Suppresses spurious LSP warnings |
| autoReplaceUnicode | \[Name] -> unicode replacement |

## Key Sections in index-with-messaging.js

| Feature | Approximate location |
|---------|----------------------|
| wl-output-header listener | Adds Wrap button to every output |
| Wrap button style | margin-left:auto (right-aligned) |
| Dialog widget | openDialogWidget() |

---

## Kernel Log



## Build & Publish



Last Updated: February 2026
