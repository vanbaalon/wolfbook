# Wolfbook Development Guide

**Version:** 2.0.0 | **Publisher:** wolfbook.wolfbook | **GitHub:** https://github.com/vanbaalon/wolfbook

See README.md for user docs. This folder contains developer reference files:

- DEVELOPMENT_GUIDE.md (this file) - architecture and history
- QUICK_REFERENCE.md - key file locations and code paths
- AUTOCOMPLETE_IMPLEMENTATION.md - LSP/autocomplete details
- config_defaults.json - unicode allowlist source data
- generate_unicode_allowlist.js - regenerates allowlist from mappings JSON
- parse_wolfram_aliases.js - parses UnicodeCharacters.tr from local Wolfram install

---

## File Layout

Source tree (edit here):
  package.json              - Extension manifest
  README.md                 - User documentation
  HowToBuild.md             - Build and install instructions
  resources/init.wl         - Kernel init script (CRITICAL)
  out/extension/controller.js           - Kernel controller, output handling
  out/extension/extension.js            - Activation, commands, LSP client
  out/client/index-with-messaging.js    - Notebook renderer webview
  EditorVariation/          - Unicode character mappings data
  themes/                   - VS Code colour themes (contributed)
  wstp/                     - Native WSTP addon (wstp.node)

Active install: ~/.vscode/extensions/wolfbook.wolfbook-2.0.0/

---

## Development Workflow

No TypeScript build step - edit JS files directly in out/:

  1. Edit out/extension/controller.js (or other out/ files)
  2. vsce package  ->  wolfbook-2.0.0.vsix
  3. code --install-extension wolfbook-2.0.0.vsix
  4. Developer: Reload Window (Cmd+Shift+P)

For quick iteration without repackaging:
  EXT=~/.vscode/extensions/wolfbook.wolfbook-2.0.0
  cp out/extension/controller.js /out/extension/controller.js && reload

---

## Key Code Locations

| Feature | File |
|---------|------|
| SVG/HTML/MathML rendering | resources/init.wl (renderWrapper) |
| Output truncation | resources/init.wl (ByteCount threshold) |
| ZMQ message loop | out/extension/controller.js (checkoutExecutionQueue) |
| Abort / restart | out/extension/controller.js (abortEvaluation, restartKernel) |
| Out[N]= header HTML | out/extension/controller.js (wl-output-header) |
| Wrap button | out/client/index-with-messaging.js |
| Diagnostic filter (LSP) | out/extension/extension.js (filterDiagnostics) |
| Unicode auto-replace | out/extension/extension.js |
| Dialog subsession | out/extension/controller.js (openDialogSubsession) |

---

## ZMQ Message Types

- evaluate-cell    (Extension -> Kernel)
- evaluation-done  (Kernel -> Extension)
- abort            (Extension -> Kernel)
- expand-output    (Extension -> Kernel)
- show-full-output (Kernel -> Extension)

---

## Debugging

Kernel logs: tail -f ~/wolfram-kernel-debug.log
Extension:   Help -> Toggle Developer Tools -> Console

note: console.log() output never appears in VS Code Output panel

---

## Development History

 1. Output format controls (Image/HTML/MathML/InputForm)
 2. Notebook background colour customisation
 3. Clear Cell Output, syntax error highlighting
 4. Abort/restart kernel controls
 5. Output truncation (ByteCount threshold, Short[expr,5], expand)
 6. /In/Out message suppression (Unprotect at startup)
 7. SVG/HTML graphics rendering, multi-output truncation fixes
 8. Silent abort/restart, race condition fix
 9. Rebrand to Wolfbook, GitHub repo
10. Cell status bar hidden, wrap button right-alignment fix

Last Updated: February 2026
