# Wolfbook — Architecture & Key Files

A guide for developers explaining the role of every significant file in the extension.

---

## Overview

Wolfbook is structured as a standard VS Code extension whose entry point registers a custom notebook type (`extended-wolfram-notebook`). All interactive behaviour is driven by the **Node.js layer** (TypeScript compiled to `out/extension/`) talking to a live **Wolfram kernel** via the native WSTP addon. A **Wolfram-side init script** runs inside the kernel at launch and provides the rendering helpers that convert Wolfram expressions into HTML/SVG/MathML/PNG for display.

```
package.json                  ← VS Code manifest (commands, menus, keybindings, settings)
out/extension/
  extension.js                ← Activation entry point; wires everything together
  controller.js               ← Kernel lifecycle + cell execution + all runtime logic
  serializer.js               ← .evsnb / .vsnb file read/write
  notebook-kernel.js          ← ExecutionQueue (ordered cell evaluation)
  notebook-config.js          ← Live VS Code settings wrapper
  notebook-settings.js        ← Per-notebook UI settings panel (background colour, etc.)
  find-kernel.js              ← Auto-discovers WolframKernel on macOS / Linux / Windows
  escape-mode.js              ← Backtick escape-sequence input (Wolfram aliases → Unicode)
  unicode-replacer.js         ← \[Alpha] → α automatic inline replacement
  ui-items.js                 ← Status-bar items and kernel-status indicator
resources/
  init.wl                     ← Wolfram init script loaded into kernel at launch
  render-html.wl              ← VsCodeRender[] — converts Wolfram output to HTML/SVG/MathML
wstp/
  build/Release/wstp.node     ← Prebuilt native addon: Node.js ↔ Wolfram WSTP bridge
  index.d.ts                  ← TypeScript types for the wstp.node addon
syntaxes/
  wolfram.tmLanguage.json     ← TextMate grammar for syntax highlighting
themes/
  wolfram-*.json              ← Colour themes (Default, Light, Dark, Dark Rainbow)
wolfram_escape_aliases.json   ← Map of Wolfram escape aliases → Unicode (e.g. "alpha" → "α")
wolfram_builtin_functions.json← List of built-in symbols for autocomplete / highlighting
unicode_allowlist.json        ← Unicode characters allowed in auto-replacement
wolfram.language-configuration.json ← Bracket matching, comment tokens for .wl files
```

---

## File-by-file

### `package.json`
The VS Code extension manifest. Defines:
- **`contributes.notebooks`** — registers `extended-wolfram-notebook` as the notebook type for `.evsnb` / `.vsnb` files
- **`contributes.commands`** — all palette commands (`wolfram.executeCell`, `wolfram.restartKernel`, `wolfram.abortEvaluation`, `wolfram.pasteImageCell`, `wolfram.pasteImageCellBelow`, etc.)
- **`contributes.menus`** — where toolbar buttons appear (`notebook/toolbar`, `notebook/cell/title`, `notebook/cell/between`, `explorer/context`)
- **`contributes.keybindings`** — keyboard shortcuts (Shift+Enter, ⌘., ⌘V, ⌘⇧V, Alt+Shift+Enter …)
- **`contributes.configuration`** — user-facing settings (`wolfram.systemKernel`, `wolfram.notebook.rendering.outputFormat`, etc.)
- **`contributes.languages`** / **`grammars`** / **`themes`** — language support for `.wl`, `.wls`, `.m` files

> **Edit this file** when adding new commands, keybindings, settings, or menu entries.

---

### `out/extension/extension.js`
**Activation entry point.** Called once by VS Code when the extension activates.

Responsibilities:
- Creates singleton instances of `FindKernel`, `WolframNotebookKernel` (controller), `VSNBContentSerializer`
- Registers the notebook serializer with VS Code
- Registers **all commands** with `vscode.commands.registerCommand` and wires them to controller methods
- Starts the **LSP client** (language server for hover/completion/diagnostics in `.wl` files)
- Initialises the **Unicode replacer** and **escape mode** for `.wl` editor files
- Sets up `onDidOpenNotebookDocument` to apply per-notebook CSS settings on open

> **Edit this file** when adding new command registrations or changing activation behaviour.

---

### `out/extension/controller.js`
**The heart of the extension** (~1 600 lines). Implements the `WolframNotebookKernel` class.

Responsibilities split by section:

| Method / area | What it does |
|---|---|
| `constructor()` | Creates output panel, status-bar items, `onDidChangeNotebookDocument` listener for GC debounce |
| `launchKernel()` | Spawns the WSTP session, loads `init.wl`, pushes initial config to kernel, sets status |
| `restartKernel()` | Tears down session and re-launches; increments `_sessionEpoch` so old outputs are cleared |
| `executeCell()` / `executeAllCells()` | Enqueues cells into `ExecutionQueue`; drives the evaluation loop |
| `_runCell()` | Core execution: sends Wolfram code via `session.sub()`, handles `Out[N]=`, `Print[]`, messages, errors, SVG/PNG/HTML output; writes rendered output as notebook cell outputs |
| `abortEvaluation()` | Calls `session.abort()` to interrupt a running kernel evaluation |
| `openDialogSubsession()` | Handles `Dialog[]` / `Input[]` interactive subsessions: shows an input widget in the notebook |
| `pasteImageAsCell()` | Reads clipboard PNG/TIFF via AppleScript + `sips`, saves to `img/<notebook>/`, inserts an HTML `<img>` Markdown cell |
| `_cleanupImgDir()` | GC: scans all cell outputs and Markdown source for live image references; deletes unreferenced `.png`/`.svg` files |
| `_applyKernelOfflineUI()` / `_clearKernelOfflineUI()` | Broadcasts `kernel-offline` / `kernel-online` messages to the renderer webview |
| `setOutputFormat*()` | Switches the session rendering format (Image / HTML / MathML / InputForm) |
| `clearCellOutput()` / `expandTruncatedOutput()` | Cell output manipulation commands |

**Key state fields:**
- `this.session` — active `WstpSession` instance (null when kernel is off)
- `this.kernelStatusString` — `'launching'` / `'resolved'` / `'error'` / `null`
- `this._sessionEpoch` — integer incremented on each restart; stamped into outputs so the renderer can clear stale ones
- `this._executionQueue` — `ExecutionQueue` instance

> **Edit this file** for any kernel communication logic, cell execution, output rendering, or new commands that need runtime kernel interaction.

---

### `out/extension/serializer.js`
**Notebook file format handler.** Implements `vscode.NotebookSerializer`.

- **`deserializeNotebook`** — parses `.evsnb` / `.vsnb` JSON → VS Code `NotebookData` (cells + metadata)
- **`serializeNotebook`** — writes VS Code `NotebookData` back to JSON on save

The `.evsnb` format extends `.vsnb` with per-cell metadata fields: `outputFormat`, `outputScale`, `customCss`, etc. The serializer preserves all unknown fields so round-trips are lossless.

> **Edit this file** if the notebook file format changes (new per-cell fields, new top-level metadata, etc.).

---

### `out/extension/notebook-kernel.js`
**Execution queue.** Implements `ExecutionQueue` — a simple FIFO list of pending cell executions.

Each item holds: `{ id, cell, execution, started }`. The controller pops from the front, marks it `started`, and resolves/rejects the VS Code `NotebookCellExecution` when the kernel responds.

> Rarely needs editing. Touch it only to change how cells are ordered or cancelled.

---

### `out/extension/notebook-config.js`
**VS Code settings wrapper.** `NotebookConfig` class provides typed accessors for all `wolfram.*` workspace configuration values and fires a callback when any setting changes.

Used by the controller to read `outputFormat`, `systemKernel`, `rendering.*` etc. without direct `vscode.workspace.getConfiguration` calls scattered everywhere.

> **Edit this file** when adding new user-facing settings that the kernel or controller needs to read at runtime.

---

### `out/extension/notebook-settings.js`
**Per-notebook UI settings panel.** `registerNotebookSettings()` installs a command that opens a QuickPick letting the user choose a background colour (and other visual options) for the currently open notebook. Settings are stored in notebook metadata and applied via injected CSS.

`applyNotebookSettings(notebook, webviewPanel)` is called from `extension.js` on notebook open to restore saved settings.

> **Edit this file** to add new per-notebook appearance options.

---

### `out/extension/find-kernel.js`
**Kernel path resolver.** `FindKernel.resolveKernel()` returns the path to `WolframKernel` / `wolframscript` by:
1. Checking the `wolfram.systemKernel` user setting
2. Scanning a hardcoded list of standard installation paths on macOS, Linux, Windows

> **Edit this file** to add new default kernel paths (e.g. for a new Wolfram version or OS).

---

### `out/extension/escape-mode.js`
**Wolfram escape-sequence input** for `.wl` editor files. When the user types `` ` `` in a Wolfram source file, it enters "escape mode": subsequent characters are matched against `wolfram_escape_aliases.json`. On match the alias is replaced with the corresponding Unicode character (e.g. `` `alpha` `` → `α`), mirroring the Mathematica front-end shortcut system.

Also provides a highlighted decoration while in escape mode so the user can see the buffer being typed.

> **Edit this file** to change escape-mode trigger, buffer handling, or decoration style.

---

### `out/extension/unicode-replacer.js`
**Inline `\[Name]` → Unicode replacement** for `.wl` editor files. Watches text document changes and immediately replaces Wolfram named-character sequences like `\[Alpha]`, `\[Infinity]` with their Unicode equivalents as the user types.

Uses `unicode_allowlist.json` to determine which characters are safe to replace inline.

> **Edit this file** to change the replacement trigger or the set of allowed characters.

---

### `out/extension/ui-items.js`
**Status-bar items.** Creates and manages the kernel status indicator shown in the VS Code status bar (e.g. "● Wolfram kernel ready" / "○ Kernel offline"). Exported symbols are instantiated by the controller and updated whenever kernel state changes.

---

### `resources/init.wl`
**Wolfram kernel initialization script.** Loaded once at kernel launch via `Get["init.wl"]`.

Key things it sets up:
- `$wolframOutputTempDir` / `$wolframImgDir` — temp directories for rendered output files
- `VsCodeSetImgDir[dir, relPrefix]` — called by the controller before each cell execution to set the per-notebook image directory
- `VsCodeRender[expr]` — the main rendering function; decides whether to produce SVG, MathML, PNG, or HTML for a given Wolfram expression (delegated to `render-html.wl`)
- `VsCodePrint[...]` / `VsCodeMessage[...]` — intercept `Print[]` and kernel messages
- Dialog subsession support: installs an `"Interrupt"` handler that calls `Dialog[]` when the kernel is interrupted mid-evaluation
- `Off[Interrupt::dgbgn]; Off[Interrupt::dgend]` — suppresses noisy dialog-entry/exit messages

> **Edit this file** to change kernel-side rendering, add new Wolfram helpers, or modify how Print/message output is sent back to VS Code.

---

### `resources/render-html.wl`
**Wolfram rendering helpers.** Implements `VsCodeRender` and format-specific sub-renderers:
- SVG export for `Graphics`, `Graph`, and all visual objects
- MathML export for symbolic/algebraic expressions
- PNG fallback for anything that cannot be rendered as SVG/MathML
- HTML table rendering for `Dataset`, `Grid`, etc.

Output files are written to `$wolframImgDir` and referenced by relative `src=` paths so the VS Code webview can load them.

> **Edit this file** to change how Wolfram output is rendered (new formats, scaling, MathML options, etc.).

---

### `wstp/build/Release/wstp.node` + `wstp/index.d.ts`
**Native WSTP addon.** A prebuilt Node.js native addon (C++) that wraps the Wolfram WSTP (inter-process communication) library. Provides:
- `new WstpSession(kernelPath, options)` — launches a kernel and establishes a WSTP link
- `session.sub(expr)` → Promise — evaluates a Wolfram expression and returns the result
- `session.abort()` — sends a kernel interrupt
- `session.terminate()` — kills the kernel process

The TypeScript declaration file `index.d.ts` documents the full API. The source for the addon lives in a separate repository: [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node).

> Do **not** edit the `.node` binary directly. Rebuild from source if a new WSTP/Mathematica version requires it.

---

### `syntaxes/wolfram.tmLanguage.json`
TextMate grammar for Wolfram Language syntax highlighting. Applied to `.wl`, `.wls`, `.m`, `.vsnb`, `.evsnb` files. Defines scopes for built-in symbols, strings, comments, operators, `$` variables, and `_` patterns.

> **Edit this file** to improve or extend syntax highlighting rules.

---

### `themes/wolfram-*.json`
VS Code colour theme files. Each provides token colours for the Wolfram grammar scopes defined in `wolfram.tmLanguage.json`, plus editor UI colours.

| File | Theme |
|---|---|
| `wolfram-Default.json` | Neutral default |
| `wolfram-light.json` | Light background |
| `wolfram-dark.json` | Dark background |
| `wolfram-dark-rainbow.json` | Dark + colourful function highlighting |

---

### `wolfram_escape_aliases.json`
Map of Wolfram escape-sequence aliases to Unicode code points (e.g. `"alpha": "α"`). Read at startup by `escape-mode.js`. To add new aliases, append entries here.

### `wolfram_builtin_functions.json`
Array of all built-in Wolfram symbol names. Used by the syntax highlighter and LSP completion fallback.

### `unicode_allowlist.json`
Whitelist of Unicode characters that `unicode-replacer.js` is allowed to auto-substitute inline when detecting `\[Name]` sequences.

### `wolfram.language-configuration.json`
VS Code language configuration for `.wl` / `.wls` / `.m` files: bracket pairs, auto-closing pairs, comment syntax (`(* ... *)`), folding rules.

---

## Data flow: cell execution

```
User presses Shift+Enter
        │
        ▼
extension.js  ──registerCommand──▶  controller.executeCell()
        │
        ▼
controller._runCell()
  │  sets up NotebookCellExecution
  │  calls VsCodeSetImgDir[] via session.sub()
  │  sends cell source via session.sub(wrapCode)
        │
        ▼  (WSTP)
  WstpSession  ──────▶  WolframKernel
                              │  evaluates expression
                              │  VsCodeRender[result] → SVG/MathML/PNG file
                              │  returns HTML string
        ◀──────  result HTML
        │
        ▼
controller  parses result  ──▶  vscode.NotebookCellOutput (text/html mime type)
        │
        ▼
VS Code renderer webview displays output in notebook
```

---

## Scrolling controls

### Wrap / Scroll toggle button for wide MathML outputs

**Where it lives:** `out/client/index-with-messaging.js`, lines ~494–562

When `renderOutputItem` runs, it queries the newly-inserted DOM for every `div.mathml-output` element (each MathML result is wrapped in one of these by the controller). For each such div it creates a small `<button>` and wires a click handler:

| State | Button label | `div` CSS |
|---|---|---|
| Default (scroll) | `↙ Wrap` | `overflow-x: auto` (horizontal scrollbar) |
| Toggled (wrap) | `↔ Scroll` | `overflow-x: hidden`, `white-space: normal`, `word-break: break-all`; all `math`/`mrow`/`mo`/`mi`/`mn`/`mfrac`/`msup`/`msub` children get `display: inline-block; overflow-wrap: break-word` |

After toggling, the renderer fires a `scroll-to-output` postMessage to the controller so the VS Code viewport snaps back to the top of the (possibly resized) output cell — see the controller's `scroll-to-output` handler at `out/extension/controller.js` line ~250.

The button is inserted into `.wl-output-header` (the flex row that contains the `Out[N]=` label) so it appears inline next to the label. If no header row is found (fallback for plain outputs) the button is inserted immediately after the `div.mathml-output`.

**CSS baseline:** `div.mathml-output { overflow-x: auto; }` is part of the `WL_CSS` constant in `renderer-css.js`, so all MathML outputs start with a horizontal scrollbar and gain the toggle button on render.

### `scroll-to-output` message (controller side)

**Where it lives:** `out/extension/controller.js`, lines ~250–275

Handler in `this._rendererMessaging.onDidReceiveMessage`. When `msg.type === 'scroll-to-output'`, the controller iterates over `vscode.window.activeNotebookEditor.notebook.getCells()`, finds the cell whose output list contains the `outputId` from the message, then calls `vscode.window.activeNotebookEditor.revealRange()` to scroll the VS Code notebook viewport to that cell.

---

## Additional styles in the renderer (`WL_CSS`)

All styles injected into the notebook output webview live in the `WL_CSS` constant in `out/client/renderer-css.js`. Notable additions beyond the base Wolfram-element styles inherited from the original `index.js`:

| Selector / rule | Purpose |
|---|---|
| `.wexpr { font-family: Consolas, Courier, monospace; }` | Monospace rendering for all Wolfram expression output |
| `.wexpr.traditional-form { font-family: 'Times New Roman', Times, serif; }` | Serif rendering when TraditionalForm is requested |
| `wfrac` margin/padding and `border-top` fraction line | Inline fraction layout tuned for the VS Code webview |
| `wsup > :last-child { vertical-align: 1.3ex }`, `wsub > :last-child { vertical-align: -0.7ex }` | Superscript / subscript vertical positioning |
| `pre.vscode-wolfram-print-output { font-size:0.85em; line-height:1.3; }` | Compact `Print[]` output lines |
| `div.mathml-output { overflow-x: auto; }` | Horizontal scrolling for wide MathML by default |
| `body { filter: grayscale(0.75) opacity(0.55); transition: filter 0.4s, opacity 0.4s; }` | Grayscale fade applied when kernel is offline (injected via `data-wolfram-kernel-state` `<style>` element, not part of `WL_CSS`) |

The grayscale style is controlled dynamically: when the controller broadcasts `kernel-offline` / `kernel-online` messages, the renderer creates or updates a separate `<style data-wolfram-kernel-state>` element in the webview document (`activate()` in `index-with-messaging.js`).

---

## Changes relative to the official Wolfram extension (v2.0.1)

The official extension (`Extension Backups/wolframresearch.wolfram-2.0.1.backup/`) is the upstream that this fork started from. The table below summarises every meaningful change by file.

### Files in common — what changed

| File | Changes |
|---|---|
| **`package.json`** | Added commands: `wolfram.abortEvaluation`, `wolfram.restartKernel`, `wolfram.clearCellOutput`, `wolfram.expandTruncatedOutput`, `wolfram.pasteImageCell`, `wolfram.pasteImageCellBelow`. Added toolbar/cell-menu entries for all of these. Added `wolfram.notebook.rendering.outputFormat`, `wolfram.notebook.rendering.outputScale` settings. Renamed extension display name to **Wolfbook**. Removed `wolfram.OpenNotebook`, `wolfram.DownloadWolframEngine`, `wolfram.openConfigurations` (upstream-only commands not used here). |
| **`out/extension/controller.js`** | Complete rewrite (~1 600 lines vs ~400 in original). Key additions: `abortEvaluation()`, `restartKernel()`, `clearCellOutput()`, `expandTruncatedOutput()`, `pasteImageAsCell()`, `openDialogSubsession()`. Truncation system (`truncatedOutputCells` map, `makeTruncationBanner()`). Session epoch tracking (`_sessionEpoch`). Kernel offline UI (`_applyKernelOfflineUI()` / `_clearKernelOfflineUI()`). Renderer messaging (`_rendererMessaging`) for `scroll-to-output`, `expand-truncated-output`, `open-truncated-as-text`, `dialog-*`. Image GC (`_cleanupImgDir()`). |
| **`out/extension/extension.js`** | Added requires for `escape-mode`, `unicode-replacer`, `notebook-settings`. Registers new commands. Wires `onDidOpenNotebookDocument` to apply per-notebook background CSS. |
| **`out/extension/serializer.js`** | Extended `.evsnb` format with per-cell `outputFormat`, `outputScale`, `customCss` metadata fields. Lossless round-trip for unknown fields. |
| **`resources/init.wl`** | Added `VsCodeSetImgDir[]`, extended `VsCodeRender[]` with SVG/MathML/PNG routing, added `VsCodePrint[]` / `VsCodeMessage[]` interceptors. Added Dialog subsession interrupt handler. |
| **`resources/render-html.wl`** | Entirely new file (did not exist in the original). Implements all format-specific renderers: SVG export, MathML export, PNG fallback, HTML table rendering for `Dataset`/`Grid`. |
| **`themes/wolfram-Default.json`** | Added scrollbar colour tokens (`scrollbarSlider.*`) and various token-colour refinements. |
| **`themes/wolfram-dark.json`** | Added scrollbar colour tokens. |

### Files added (not present in the official extension)

| File | Purpose |
|---|---|
| **`out/client/index-with-messaging.js`** | Renderer entry point (~1070 lines). Exports `activate(context)`. Imports from `renderer-css.js` and `renderer-highlight.js`. Contains: splash screen, state vars, message listener, wexprToInputForm, dialog widget, renderOutputItem (expand/format/copy/KaTeX buttons, height sentinel), disposeOutputItem. |
| **`out/client/renderer-css.js`** | DEV_MODE flag + `console.log` gate + `WL_CSS` stylesheet constant. Imported by `renderer-highlight.js`. Side-effect on import: silences console.log in production builds. |
| **`out/client/renderer-highlight.js`** | `applyInlineHighlight(pre, lang)`, `injectRendererCSS(doc)`, `addLineNumberGutter(pre)`. Imports `WL_CSS` from `renderer-css.js`. |
| **`out/extension/escape-mode.js`** | Backtick escape-alias input for `.wl` editor files. |
| **`out/extension/unicode-replacer.js`** | `\[Name]` → Unicode inline auto-replacement for `.wl` files. |
| **`out/extension/notebook-settings.js`** | Per-notebook background colour / appearance QuickPick panel. |
| **`out/extension/notebook-config.js`** | Typed wrapper for `wolfram.*` VS Code settings. |
| **`out/extension/ui-items.js`** | Status-bar kernel indicator items. |
| **`wolfram_escape_aliases.json`** | Alias → Unicode map consumed by `escape-mode.js`. |
| **`wolfram_builtin_functions.json`** | Built-in symbol list for syntax highlighting and LSP fallback. |
| **`unicode_allowlist.json`** | Characters allowed for inline `\[Name]` auto-substitution. |
| **`EditorVariation/`** | Alternative renderer variant files. |

### Files unchanged from the official extension

`wolfram.language-configuration.json`, `syntaxes/wolfram.tmLanguage.json` (minor token additions only), `themes/wolfram-light.json`, `themes/wolfram-dark-rainbow.json`, `wstp/` binary addon.

---

## Adding a new command — checklist

1. **`package.json`** — add entry in `contributes.commands`; optionally add to `contributes.menus` and/or `contributes.keybindings`
2. **`out/extension/extension.js`** — `registerCommand("wolfram.myCommand", () => controller.myMethod())`
3. **`out/extension/controller.js`** — implement `myMethod()` on `WolframNotebookKernel`
4. Run `bash deploy-extension.sh quick` and reload the VS Code window
