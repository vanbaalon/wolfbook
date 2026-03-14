# Wolfbook — The First Fully AI-Enabled Mathematica Notebook for VS Code

<p align="center">
  <img src="images/wolfbook_logo.png" alt="Wolfbook logo" width="320"/>
</p>

**Wolfbook** is a VS Code extension that turns `.evsnb` / `.vsnb` / `.wb` files into interactive Wolfram Language notebooks, backed by a live kernel connected via a bespoke native WSTP (Wolfram Symbolic Transfer Protocol) connector — no subprocess piping, no ZeroMQ. For quick start: create an empty `test.wb` file and open it.

Wolfbook brings a near-Mathematica notebook experience directly into VS Code — and goes further by integrating all of VS Code's modern AI tooling right in your notebook. Use GitHub Copilot in Agent mode to read your notebook, evaluate expressions in the live kernel, look up documentation, and insert new cells, all without leaving your workspace.

Rendering symbolic math and graphics uses a bespoke **wolfbook-btl** (Box-to-LaTeX) native addon that translates Wolfram's internal `TraditionalForm` box structures to LaTeX, enabling high-quality typeset output with no internet dependency.

> Author: Nikolay Gromov — [nikolay.gromov@kcl.ac.uk](mailto:nikolay.gromov@kcl.ac.uk)  
> License: Apache 2.0 (see [LICENSE.txt](LICENSE.txt))

---

## 🤖 GitHub Copilot Integration

**Wolfbook is the first Wolfram Language notebook with deep GitHub Copilot agent integration.**

Switch Copilot to **Agent mode** and it gains live access to your running kernel: it can read your entire notebook, evaluate expressions, look up documentation, and insert new cells — all without leaving VS Code.

### What Copilot can do with Wolfbook

| Tool | Reference | What Copilot can do |
|------|-----------|---------------------|
| 📋 **Get notebook context** | `#wolfbookContext` | Reads all cells and their outputs — Copilot sees exactly what you've computed |
| ⚡ **Evaluate expression** | `#wolfbookEval` | Runs any Wolfram Language expression in your live kernel and gets the result back |
| 🔍 **Look up symbol** | `#wolfbookLookup` | Retrieves full usage docs, options table, and a link to the online reference for any symbol — built-in or user-defined |
| 🌐 **Full web help** | `#wolfbookWebHelp` | Fetches and returns the complete Wolfram reference page for a built-in symbol — examples, details, and all |
| ➕ **Insert cell** | `#wolfbookInsert` | Adds a new code or markdown cell at any position in your notebook |
| ✏️ **Edit cell** | `#wolfbookEdit` | Replaces the source of an existing cell in-place; set `evaluate:true` to immediately run the new content and verify the result |
| ▶️ **Run cell** | `#wolfbookRun` | Executes an existing cell through the normal pipeline (equivalent to Shift+Enter); the result is stored as the cell's output and visible to the user |
| 🗑️ **Delete cell** | `#wolfbookDelete` | Removes a cell from the notebook; the deleted source is saved to `ai_deleted_cells.md` for recovery before deletion |
| 🔎 **Kernel state** | `#wolfbookState` | Lists all user-defined symbols matching a context pattern, showing their current values or rule counts — use this to understand what is already defined before writing code |
| 💾 **Save notebook** | `#wolfbookSaveNotebook` | Saves the active notebook to disk — call this after a batch of insertions, edits, or deletions to persist the changes |
| 📥 **Restart kernel** | `#wolfbookRestart` | Restarts the Wolfram kernel with a confirmation dialog — clears all definitions and resets the session |
| ⏹️ **Abort evaluation** | `#wolfbookAbort` | Interrupts the currently running evaluation — equivalent to the Abort button in the toolbar |
| 🐛 **Debug session** | `#wolfbookDebug` | Full AI control of the step-through debugger: analyze cell structure, start/stop sessions, step over/into/out, set and remove breakpoints, and manage the Watch Panel variable list — see [AI-controlled Debugging](#ai-controlled-debugging) below |

### How to activate

1. Open the Copilot Chat panel (`⌃⌘I`)
2. Switch to **Agent** mode (dropdown at the top of the panel)
3. Open a Wolfbook notebook (`.wb`) and start the kernel
4. Ask anything — Copilot automatically reads your full notebook context

### Example prompts

```
"What does the function BBrel do in my notebook?"
"Verify that x + 1/x = u/g for the ZhukovskyX function using u=5, g=0.1"
"Add a cell at the end that plots the residuals of my QSC equations"
"What are all the options for FindRoot? I want to set WorkingPrecision."
"My Solve call is returning {} — debug it using the values in cell 3"
"Fetch the NIntegrate documentation page and show me the available Method options"
"Fix the bug in cell 7 without adding a new cell"
"Re-run cell 5 to refresh its output after the kernel restart"
"Delete cell 12 — it's superseded by cell 15"
"What symbols have I defined so far? Show me the kernel state."
"Save the notebook after making these edits"
"Analyze the step structure of cell 4, set a breakpoint at line 6, then step through it"
"Add x and i to the watch list, then debug cell 3 and tell me what goes wrong"
```

You can also reference tools directly in your prompt:
- `#wolfbookContext` — read all notebook cells and outputs before asking a question
- `#wolfbookEval Integrate[1/(x^2+1), x]` — evaluate in the live kernel
- `#wolfbookLookup NDSolve` — look up usage, options, and documentation link
- `#wolfbookWebHelp NMinimize` — fetch the full online reference page
- `#wolfbookEdit` — replace the source of a cell (used automatically when Copilot fixes a cell)
- `#wolfbookRun` — re-run a cell and get its output (stores result in the notebook)
- `#wolfbookDelete` — remove a cell (recovery copy written to `ai_deleted_cells.md`)
- `#wolfbookState` — list all user-defined symbols and their current values
- `#wolfbookSaveNotebook` — persist the notebook to disk
- `#wolfbookDebug` — control the step-through debugger (analyze, start, step, breakpoints, watch list)

### Kernel safety

The tools are kernel-aware and safe to use at any time:
- **Kernel busy detection** — if a notebook cell is currently evaluating, `#wolfbookEval` and `#wolfbookLookup` refuse to dispatch and return a clear "kernel is busy" message instead of queuing a competing evaluation that could corrupt the WSTP link.
- **Dynamic widget awareness** — if `Dynamic[...]` widgets are active, evaluation tools note this but remain safe to use (Dynamic runs on a separate sub-channel).
- **Timeout abort** — if an evaluation exceeds `timeoutSeconds`, the kernel is cleanly interrupted via `session.abort()` so it is immediately ready for the next request.
- **Eval log rotation** — `ai_eval_log.md` (in `img/<notebook>/`) records every expression Copilot evaluates with its result. The log is automatically cleared when the kernel restarts so it stays relevant to the current session.

### WBExport — save the notebook as a Mathematica `.nb` file

Type `WBExport[]` in any code cell to convert the current notebook to a standard Mathematica `.nb` file saved alongside it. An optional path argument redirects the output:

```wolfram
WBExport[]               (* saves as <notebook-name>.nb next to the .wb file *)
WBExport["output.nb"]    (* relative path from the notebook's directory *)
WBExport["/abs/path/to/result.nb"]
```

- **Never sent to the kernel** — intercepted by the extension like `WBInclude`.
- Markdown heading cells (`#`, `##`, `###`, `####`) become Wolfram `Title`, `Section`, `Subsection`, `Subsubsection` cells.
- Markdown text cells become `Text` cells; code cells become `Input` cells.
- The resulting `.nb` opens directly in Mathematica or the Wolfram Desktop.

### WBInclude — import a Mathematica notebook

Type `WBInclude["path/to/file.nb"]` in any code cell to inline another Mathematica notebook directly into the current one. The path may be absolute or relative to the host notebook's directory.

```wolfram
WBInclude["SolvingBaxter.nb"]          (* relative path *)
WBInclude["/abs/path/to/library.nb"]   (* absolute path *)
```

- The `.nb` file is converted to cells using the bundled converter (no Mathematica frontend required).
- A `## Included: filename.nb` markdown header is inserted first, then all converted cells, immediately after the `WBInclude` cell.
- The `WBInclude` expression itself is **never sent to the kernel** — it is intercepted by the extension.
- All temporary files are created in the system temp directory and cleaned up automatically.

---

### Cell-level CRUD

Copilot has full read/write/delete access to notebook cells — not just the ability to append new ones:

- **`#wolfbookEdit`** replaces the source of any existing cell. Pass `evaluate:true` to run the updated content immediately and have the result returned to Copilot for verification.
- **`#wolfbookRun`** executes an existing cell through the standard Wolfbook pipeline. Unlike `#wolfbookEval`, the result is stored as the cell's output in the notebook (visible in the editor), not just returned to the chat.
- **`#wolfbookDelete`** removes a cell. Before deleting, the source is appended to `img/<notebook>/ai_deleted_cells.md` so nothing is permanently lost.
- **`#wolfbookState`** queries the live kernel for all symbols in a given context (default: `Global\`*`) and returns their current values or rule counts. Useful before writing new code to avoid name conflicts.
- **`#wolfbookSaveNotebook`** saves the active notebook to disk. Call this at the end of a batch edit session to ensure no changes are lost.

---

## Features

### Key improvements over the official extension

- **Mid-evaluation abort** — interrupt a running computation at any time via the toolbar or `Abort` command; the kernel recovers cleanly and is immediately ready for new input. The official extension does not support this.
- **Dynamic widget support with mid-evaluation monitoring** — `Dynamic[expr]` widgets update live even while the kernel is busy evaluating other cells. The official extension has no Dynamic support.
- **Step-by-step debugger** *(new in v2.2)* — set breakpoints with `F9` (or a gutter click), then press `Cmd+Shift+D` to step through a cell statement by statement. Timing annotations, a live variable watch panel, and auto-advance to the next cell are all included. See [Step-by-Step Debugger](#-step-by-step-debugger-new-in-v22) below.
- **Live Watch Panel** *(new in v2.2)* — the Wolfbook Watch sidebar is useful even without a debug session. Open it from the Run & Debug sidebar to monitor any Wolfram expression between evaluations. See [Live Watch Panel](#-live-watch-panel-new-in-v22) below.
- **Evaluate Selection** *(new in v2.2)* — press `Cmd+Shift+E` to evaluate the current text selection in the sidebar without running the full cell. The result renders in the Watch Panel with full LaTeX/SVG/MathML formatting. See [Evaluate Selection](#-evaluate-selection-cmdshifte-new-in-v22) below.
- **Rich rendering pipeline with native LaTeX** — results are rendered as **SVG**, **MathML**, or **LaTeX** (via the bespoke **wolfbook-btl** C++ addon that translates Wolfram's `TraditionalForm` box structures to high-quality KaTeX). The official extension renders only plain text or basic HTML.
- **Smart two-mode evaluation scroll** — pressing Shift+Enter automatically chooses the optimal scroll behaviour depending on whether the cell was edited:
  - **Advance mode** (unchanged cell) — the evaluated cell scrolls to the top of the viewport the moment you press Shift+Enter, before output arrives. Output fills in below without any further viewport jump. Focus advances to the next cell so you can keep evaluating.
  - **Refine mode** (cell was edited since last run) — the viewport stays completely still. Focus returns to the same cell in edit mode with the cursor restored, so you can immediately continue editing. Use this mode when iterating on a single cell.
  - Auto-detection works on first run too: if you edit a fresh cell before ever running it, it correctly enters Refine mode. The active mode is shown in the status bar (bottom-right) and can be forced with the toolbar button.
- **AI-readable output layer** — every cell output carries a `text/plain` MIME item containing a clean, readable summary (InputForm result, error messages, and kernel warnings) alongside the rich HTML. This is what the `#wolfbookContext` tool reads — Copilot sees exactly what was computed in each cell, with no HTML noise. The official extension has no machine-readable output format or notebook specific agentic tools.


---

### 🐛 Step-by-Step Debugger *(New in v2.2)*

Ever wondered why a loop gives the wrong answer after 10 iterations? Now you can watch it happen — one step at a time.

Wolfbook v2.2 adds a **full interactive debugger** built directly into the notebook, with no setup required. Just press `Cmd+Shift+D` on any code cell to start a debug session.

**What you can do:**

| Action | Key | What happens |
|--------|-----|--------------|
| Start debugging a cell | `Cmd+Shift+D` | Instructs the kernel to pause at each statement |
| Step Over | `F10` | Run the current statement and stop at the next one |
| Step Into | `F11` | Enter the body of a loop (go deeper) |
| Step Out | `⇧F11` | Finish the current loop body and return to the outer level |
| Continue to Breakpoint | `F5` | Run freely until the next breakpoint |
| Run to End | `Ctrl+F5` | Run the rest of the cell without pausing |
| Stop session | `⇧F5` | Abort and clean up |
| Toggle Breakpoint | `F9` | Mark a line — execution will pause here during Continue |
| **Evaluate Selection** | `Cmd+Shift+E` | Evaluate selected expression; result shown in Watch Panel |
| **Add Selection to Watch** | `Cmd+Shift+W` | Add selected expression to the live watch list |

You can also click in the left gutter (to the left of the line numbers) to set or clear a breakpoint with a single click.

**The Watch Panel** (Run & Debug sidebar → Wolfbook Watch) shows:
- The current step position and loop iterator values (`i = 3`, `j = 1`, …)
- A live table of any variables you want to track — add them by typing a name and pressing Enter
- Timing annotations (`⏱ 12.3 ms`) that appear inline in the cell editor right after each statement completes
- A `⏳` indicator while the kernel is evaluating the current step
- Print output and kernel messages appear live in the cell's output area as each step runs
- All registered breakpoints — click `×` to remove individual ones

**Auto-advance**: when a cell finishes debugging cleanly, the session automatically continues with the next code cell in the notebook — perfect for stepping through a sequence of cells.

**The ▶ Debug button** at the top of the Watch Panel lets you start a debug session on the focused cell without leaving the panel.

#### AI-controlled Debugging

Copilot can drive the debugger autonomously via the `#wolfbookDebug` tool. This enables prompts like:

> *"Analyze the step structure of cell 4, set a breakpoint at line 6, watch `x` and `i`, then start a debug session and report the variable values when the breakpoint is hit."*

Available actions:

| Action | What Copilot can do |
|--------|---------------------|
| `analyze` | Inspect a cell's step structure before starting — sees step count, depth levels, loop variables, and the full instrumented code |
| `start` / `stop` | Start or abort a debug session on any cell by number |
| `status` | Read the current position (depth, step, iterator values) |
| `stepOver` / `stepInto` / `stepOut` | Issue step commands and get back the new position |
| `continue` / `runToEnd` | Run to the next breakpoint or to completion |
| `addBreakpoint` / `removeBreakpoint` | Set or remove a breakpoint on a specific line of a cell |
| `clearBreakpoints` / `listBreakpoints` | Clear all breakpoints or list currently registered ones |
| `addWatch` / `removeWatch` / `listWatch` | Manage the Watch Panel variable list |

---

### 📡 Live Watch Panel *(New in v2.2)*

The **Wolfbook Watch** sidebar panel works in two modes:

**During a debug session** — shows the current step position, iterator variables, timing annotations, registered breakpoints, and a live table of any watched variables. The breakpoints list and step-controls are only visible when a session is active.

**Outside debugging (live watch mode)** — the panel switches to a clean, minimal view: just the watch table and the **Evaluate Selection** result area. You can add any Wolfram expression to the watch list, and the values are refreshed after every cell evaluation. This is useful for monitoring intermediate values (`acc`, `n`, `result`) across multiple cells without setting up a debug session.

To add expressions to the watch list:
- Type an expression in the input field at the bottom of the Watch Panel and press Enter
- Or select any expression in the notebook editor and press `Cmd+Shift+W`

In both cases the expression is validated for correct bracket balance and string closure before being added. Invalid expressions show an immediate error without modifying the watch list.

---

### ⚡ Evaluate Selection (`Cmd+Shift+E`) *(New in v2.2)*

Select any Wolfram Language expression in a cell and press `Cmd+Shift+E` to evaluate it instantly — without running the full cell.

- The result is rendered in the **Watch Panel** sidebar with full formatting (LaTeX, SVG/graphics, MathML — the same pipeline as normal cell output). The render format can be changed per-evaluation via the status bar picker.
- Works even when the kernel is busy evaluating another cell (uses the same `Dialog[]` interrupt path as Dynamic widgets).
- **Large results** are automatically truncated to keep the sidebar responsive. The sidebar shows the approximate size and a link to open the full HTML in the editor.
- **Disabled during a debug session** — pressing `Cmd+Shift+E` while a debug session is active shows a message rather than attempting to interrupt the paused kernel.
- The last evaluation is cached and re-displayed if you close and reopen the Watch Panel.

**Shortcut:** `Cmd+Shift+W` — select any expression, press `Cmd+Shift+W` to add it straight to the live watch list (syntax is validated first).

---

### ⌨️ Keyboard Navigation *(Improved in v2.2)*

Wolfbook's keyboard handling is designed to feel like a proper notebook, not a plain code editor.

**Escape key — alias mode**

Press `Escape` to enter *alias mode* (like Mathematica's Esc-alias shortcut): type a short name like `alpha`, `sqrt`, or `ii` and Wolfbook replaces it with the corresponding Unicode character (`α`, `√`, `ⅈ`, …). Press Escape again (or wait) to cancel.

**Arrow keys — navigate between cells without the mouse**

When a cell is selected but you are *not* actively editing (command mode):
- `←` — jump to the nearest **code cell above**, cursor placed at the end (ready to continue typing)
- `→` — jump to the nearest **code cell below**, cursor placed at the start; if there is no code cell below, a new empty one is created

When you *are* editing a cell:
- `←` at the very start of the cell (line 0, character 0) — exits edit mode (same as Escape)
- `→` at the very end of the last line — exits edit mode

This means you can navigate entire notebooks with just arrow keys — press `→` to enter the next cell and start typing immediately.

---

### 📜 Smart Scroll on Evaluation *(Improved in v2.1–v2.2)*

Pressing `Shift+Enter` to evaluate a cell now uses intelligent scroll behaviour depending on whether you edited the cell:

- **Advance mode** (unchanged cell) — the cell snaps to the top of the viewport the moment you press `Shift+Enter`, before any output arrives. The output fills in below the cell without the viewport jumping. Focus moves to the next cell.
- **Refine mode** (cell was edited) — the viewport stays completely still. Focus returns to the same cell with the cursor exactly where you left it, so you can keep iterating immediately.

The active mode is shown in the status bar (bottom-right) and can be forced with the toolbar button. Both modes prevent VS Code's default "scroll to the new output" behaviour which can be disorienting in large notebooks.



Place `Dynamic[expr]` on its own line (or alongside static expressions in the same cell) to get a live-updating output slot:

```wolfram
Dynamic[n]                          (* shows current value of n, updates live *)
Dynamic[ListPlot[Range[n]]]         (* plot re-renders every ~500 ms *)
```

The widget fires on two paths:
- **Busy kernel** — sends one interrupt, opens `Dialog[]`, evaluates the expression in the dialog subsession, renders via a dedicated render subkernel, closes the dialog, repeats every ~500 ms.
- **Idle kernel** — evaluates directly via a priority `sub()` call at most once per second.

**Expiry options** control when the widget stops and its output is cleared:

| Option | Counts | Fires when… |
|---|---|---|
| `LiveTime -> t` | wall-clock seconds | `t` seconds have elapsed (fires immediately, mid-computation) |
| `LiveEvaluations -> n` | sub-expression dispatches | the `n`-th sub-expr *finishes* (one Shift+Enter on a 3-line cell = 3 dispatches) |
| `LiveCells -> n` | cell-level dispatches | the `n`-th Shift+Enter *finishes* (regardless of line count) |

Options can be combined; the first condition to fire wins:
```wolfram
Dynamic[Pi, LiveTime -> 60, LiveEvaluations -> 2]
```

**Early-start in mixed cells** — if `Dynamic[expr]` appears before other expressions in the same cell, the widget starts updating immediately while the rest of the cell is still evaluating:
```wolfram
Dynamic[n, LiveEvaluations -> 2]    (* starts live immediately *)
Do[n = k; Pause[0.5], {k, 1, 20}]  (* runs concurrently *)
```

---

### Interactive Notebook
- **WSTP kernel backend** — connects directly to a local Wolfram/Mathematica kernel via the native [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node) addon (no ZeroMQ, no subprocess piping)
- **MathML, SVG, PNG, HTML and InputForm** output rendering — switchable per session
- **Out[N]= labels** with session tracking — labels clear automatically on kernel restart
- **Print[] output** rendered as preformatted text, interleaved with results
- **Kernel messages** (warnings, errors) shown inline in amber
- **Per-cell output format buttons** — each output header shows format buttons to switch rendering on the fly; the chosen format is remembered per cell for the session. Two button sets are shown depending on output type:
  - **Graphics outputs** (plots, `Graphics[…]`, images): **WL** (InputForm text) | **SVG** (rasterized image) | **TikZ** (TikZ source code for LaTeX documents)
  - **Symbolic/expression outputs**: **WL** (InputForm text) | **SVG** (rasterized image) | **SVG.T** (rasterized TraditionalForm typeset image) | **TeX** (KaTeX-rendered LaTeX via Wolfram's TeXForm) | **src** (raw LaTeX from TeXForm) | **LaTeX** (KaTeX-rendered, via the wolfbook-btl addon) | **src** (raw LaTeX source from the wolfbook-btl addon) | **∑** (MathML)
- **LaTeX rendering** — three display paths are available for symbolic expressions:
  - *TeX*: uses Wolfram's built-in `ToString[expr, TeXForm]` to produce LaTeX, then renders it with KaTeX in the webview. Quick and reliable for most standard maths.
  - *LaTeX*: uses `MakeBoxes[expr, TraditionalForm]` to extract the Wolfram box structure, passes it through the bespoke **wolfbook-btl** C++ addon (`boxToLatex`), sends the resulting LaTeX to the webview and renders it client-side with KaTeX. Gives better results for expressions that don't convert well via TeXForm.
  - *src (after LaTeX)*: same wolfbook-btl box-to-LaTeX path, but shows the raw LaTeX source as a syntax-highlighted code block rather than rendering it — useful for copying LaTeX into documents.
  - All LaTeX modes show a ⚠️ warning if the addon encounters an unsupported box structure, and the *LaTeX* mode includes a fold-out debug panel with raw boxes and the LaTeX string.
- **TikZ export** — the SVGSrc format renders a `Graphics[…]` cell to SVG, then converts it to TikZ source via `svg2tikz --codeoutput codeonly`. The output is a code block prefixed with `% \usepackage{tikz}` that can be pasted directly into a LaTeX document.
- **Notebook-level default format** — double-click any format button to promote it to the notebook default. Wolfbook now maintains two separate defaults: one for **graphics** outputs (plots, images) and one for **expression** outputs (symbolic results). The correct default is chosen automatically based on each output's type.
- **Authoritative graphics detection** — the Wolfram rendering layer (`VsCodeRender`) embeds a hidden marker in the output HTML when the expression is graphical. Button sets are assigned based on this marker, not by CSS-class heuristics, so format buttons are always correct even when expressions are rasterized.
- **MathML zoom** — ⊕/⊖ buttons scale all MathML outputs globally in one click
- **Wrap / Scroll toggle** on wide MathML outputs
- **Truncated output** for large results — "Expand" and "Open as text" controls; format buttons are correctly restored after expanding a truncated output
- **1 MB output limit** — HTML outputs up to 1 MB are displayed in full before truncation kicks in (raised from 64 KB)
- **Dialog[] subsessions** — interactive `Input[]` / `DialogInput[]` via an in-notebook widget

### Kernel Control
- **Abort** — sends interrupt to the running evaluation
- **Restart** — relaunches the kernel cleanly
- **Kernel status indicator** — notebook dims when kernel is offline

### Editor
- **Syntax highlighting** for `.wl`, `.wls`, `.m`, `.vsnb`, `.evsnb` files
- **LSP diagnostics** — powered by Wolfram's `LSPServer` package (hover, completion, error underlining)
- **Unicode input** — type `\[Alpha]` and it auto-replaces to `α`; or use `` ` `` + alias (Mathematica-style escape sequences)
- **Themes** — Coloured themes for distinguished look: Light, Dark, Dark Rainbow
- **Paste image as cell** *(macOS only)* — copy any image to the clipboard, then:
  - `⌘V` with a cell selected (but not in edit mode) — inserts the image immediately as a new Markdown cell below
  - `⌘⇧V` anywhere in the notebook — shows a prompt to insert the image above or below the current cell

  Images are saved as PNGs inside `img/<notebook-name>/` next to the notebook and garbage-collected automatically when their cells are deleted.

---

## Requirements

- [Wolfram Mathematica](https://www.wolfram.com/mathematica/) or [Wolfram Engine](https://www.wolfram.com/engine/) installed locally
- VS Code 1.95+
- The bespoke **WSTP connector** (`wstp.node`) — a native Node.js addon that connects directly to the Wolfram kernel via the WSTP protocol. Prebuilt for **macOS** (Apple Silicon and Intel); Windows support is planned for a future release.
- The bespoke **wolfbook-btl** addon (`wolfbook_btl.node`) — a native C++ addon that translates Wolfram `TraditionalForm` box structures to LaTeX. Also prebuilt for macOS only currently; Windows support coming.

Both native addons are bundled inside the `.vsix` so no separate build step is needed on macOS.

---

## Installation

1. Download the `.vsix` from the [Releases](https://github.com/vanbaalon/wolfbook/releases) page
2. In VS Code: `Extensions` → `⋯` → `Install from VSIX…`
3. Open or create a `.evsnb` file — the kernel launches automatically on first cell execution

The extension auto-detects the Wolfram kernel. If it is not found, set the path in settings:

```
wolfram.systemKernel → /path/to/WolframKernel
```

---

## Building from Source

```bash
cd "Extension Development"
npm install
npm run compile      # tsc + webpack
npx vsce package     # produces wolfbook-x.y.z.vsix
code --install-extension wolfbook-x.y.z.vsix
```

See [dev/](dev/) for architecture and build notes.

---


## Acknowledgements

Wolfbook was heavily inspired by and initially based on the official [vscode-wolfram](https://github.com/WolframResearch/vscode-wolfram) extension by Wolfram Research Inc. (Apache 2.0). The LSP client layer and kernel-finding logic originate from that project. The notebook frontend and the entire kernel backend have since been rewritten from scratch.

The WSTP native addon is a separate project: [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node).

---

**Disclaimer:** Wolfbook is an independent open-source project and is not affiliated with, endorsed by, or supported by Wolfram Research Inc. "Wolfram", "Mathematica", and "Wolfram Language" are trademarks of Wolfram Research Inc.

---
