# Wolfbook — The First Fully AI-Enabled Mathematica Notebook for VS Code

<p align="center">
  <img src="images/wolfbook_logo.png" alt="Wolfbook logo" width="320"/>
</p>

**Wolfbook** is a VS Code extension that turns `.evsnb` / `.vsnb` / `.wb` files into interactive Wolfram Language notebooks, backed by a live kernel connected via a bespoke native WSTP (Wolfram Symbolic Transfer Protocol) connector — no subprocess piping, no ZeroMQ. For quick start: create an empty `test.wb` file and open it.

Wolfbook brings a near-Mathematica notebook experience directly into VS Code — and goes further by integrating all of VS Code's modern AI tooling right in your notebook. Use GitHub Copilot in Agent mode to read your notebook, evaluate expressions in the live kernel, look up documentation, and insert new cells, all without leaving your workspace.

Rendering symbolic math and graphics uses a bespoke **wolfbook-btl** (Box-to-LaTeX) native addon that translates Wolfram's internal `TraditionalForm` box structures to LaTeX, enabling high-quality typeset output with no internet dependency.

> Author: Nikolay Gromov — [nikolay.gromov@kcl.ac.uk](mailto:nikolay.gromov@kcl.ac.uk)  
> License: Apache 2.0 (see [LICENSE.txt](LICENSE.txt))

> Latest release: **v2.6.37** (2026-04-13). See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## 🤖 GitHub Copilot Integration

**Wolfbook is the first Wolfram Language notebook with deep GitHub Copilot agent integration.**

Switch Copilot to **Agent mode** and it gains live access to your running kernel: it can read your entire notebook, evaluate expressions, look up documentation, and insert new cells — all without leaving VS Code.

### What Copilot can do with Wolfbook

Ten tools can be referenced directly in chat with `#name`; the rest are invoked automatically by the AI agent.

#### Directly referenceable tools (`#name` shorthand)

| Tool | Reference | What Copilot can do |
|------|-----------|---------------------|
| 📋 **Get notebook context** | `#wolfbookContext` | Reads all cell sources and outputs for the active notebook. Also: `action:"list"` lists open notebooks, `action:"switch"` changes the active notebook, `action:"save"` saves to disk |
| ⚡ **Evaluate expression** | `#wolfbookEval` | Runs any Wolfram Language expression in the live kernel and returns the result. Use `multiLine:true` to evaluate a block line-by-line. Add `outputForm:"Short"` for a truncated preview, `outputForm:"TeXForm"` for LaTeX output, or `outputForm:"MatrixForm"`/`"TableForm"` for structured display |
| 🔍 **Look up symbol** | `#wolfbookLookup` | Retrieves usage docs, options table, and an online reference link for any symbol — built-in or user-defined. Add `fetchWeb:true` to fetch the full Wolfram reference page |
| ➕ **Insert cells** | `#wolfbookInsertCells` | Inserts one or more cells at any position. Pass top-level `kind`+`content` for a single cell, or a `cells:[...]` array for multiple. Use `afterCellId`/`afterCell` + `position:"before"\|"after"` to target precisely. Set `evaluate:true` to run immediately |
| ✏️ **Edit cell** | `#wolfbookEdit` | Replaces the source of an existing cell in-place; set `evaluate:true` to immediately run the new content and verify the result |
| ▶️ **Run cell(s)** | `#wolfbookRun` | Executes a cell (by `cellId` or `cellNumber`) or a range of cells (`startCell`/`endCell`). Set `stopOnError:true` (default) to halt on the first error in range mode |
| 🗑️ **Delete cell(s)** | `#wolfbookDelete` | Removes one or more cells; deleted content is saved to `ai_deleted_cells.md` for recovery — pass `cellId`/`cellIds` (preferred) or `cellNumber`/`cellNumbers` |
| 🔍 **Search cells** | `#wolfbookSearch` | Finds cells by text or regex, optionally filtered by kind (`"code"`/`"markdown"`). Returns cell numbers, CellId values, and source previews |
| 🔎 **Kernel state** | `#wolfbookState` | Lists all symbols matching a context pattern (default `Global\`*`) with their current values or rule counts — call this before writing code to avoid naming conflicts |
| 📚 **Paper search** | `#wolfbookPaper` | Search academic papers (HEP/math/physics) via INSPIRE-HEP with arXiv fallback. Five actions: `action:"search"` finds papers by `title`, `author`, `abstract`, arXiv ID or INSPIRE texkey; `action:"bibtex"` returns a BibTeX `@article` record; `action:"bibitem"` returns a LaTeX `\bibitem`; `action:"references"` lists all papers cited by a paper (add `includeContexts:true` for Semantic Scholar citation snippets); `action:"citations"` lists papers that cite a paper with citation context sentences. Results include INSPIRE citation counts and ar5iv HTML links. Accepts arXiv IDs in both new (`2103.15840`) and old (`hep-th/0212208`) formats, INSPIRE texkeys (`Gromov:2013pga`), or plain INSPIRE record IDs. Primary source: INSPIRE-HEP; falls back to arXiv API for non-HEP papers. |

#### AI-invoked tools (used automatically, no `#` shorthand)

| Tool | What Copilot can do |
|------|---------------------|
| ↩️ **Restore deleted cells** (`wolfbook_restoreDeletedCells`) | Lists or re-inserts recently deleted cells from `ai_deleted_cells.md`; use `action:"list"` to see what was removed, `action:"restore"` to re-insert |
| ↕️ **Move cell** (`wolfbook_moveCell`) | Moves a cell atomically (delete + re-insert); use `toPosition:0` to move to beginning, or `afterCellId` for stable targeting |
| 💾 **Kernel control** (`wolfbook_kernelControl`) | `action:"restart"` restarts the kernel (clears all state); `action:"abort"` interrupts the current evaluation; `action:"checkpoint"` saves all your definitions to a snapshot file; `action:"restore"` reloads a previous snapshot — useful as a rollback point before risky edits |
| 📦 **Find package** (`wolfbook_findPackage`) | Searches simultaneously on the Wolfram Paclet Server and GitHub — returns install commands for each result |
| 🐛 **Debug session** (`wolfbook_debugCell`) | Full AI control of the step-through debugger: analyze, start/stop, step over/into/out, breakpoints, Watch Panel — see [AI-controlled Debugging](#ai-controlled-debugging) |
| 🟥 **Kernel crash log** (`wolfbook_kernelCrashLog`) | Reads `img/<notebookName>/wolfram-kernel-debug.log` and macOS crash reports to diagnose kernel crashes |
| 📄 **File operations** (`wolfbook_fileOps`) | `action:"read"` reads a file, `action:"write"` creates/overwrites a file, `action:"list"` lists directory contents with optional `ext` and `depth` filters |
| 🖥️ **Run terminal** (`wolfbook_runTerminal`) | Runs a shell command and returns stdout/stderr (builds, tests, scripts, git, LaTeX workflows) |

### How to activate

There are two ways to use Copilot with Wolfbook:

**Option 1 — `@wolfbook` chat participant** *(recommended)*

1. Open the Copilot Chat panel (`⌃⌘I`)
2. Type `@wolfbook` followed by your question or request
3. Wolfbook automatically injects notebook state, kernel status, and Wolfram Language best practices into every conversation

`@wolfbook` has four slash commands:

| Command | What it does |
|---------|-------------|
| `/run` | Run cells in the notebook and report results |
| `/explain` | Explain what the code in the notebook does |
| `/debug` | Debug errors and fix issues in the notebook |
| `/insert` | Insert new cells into the notebook |

Examples:
```
@wolfbook what does the function BBrel do?
@wolfbook /run all cells from 3 to 20
@wolfbook /debug why is cell 7 returning {}?
@wolfbook /insert a cell that plots the residuals
@wolfbook /explain the QSC equations in this notebook
```

**Option 2 — Agent mode** (works without `@wolfbook`)

1. Open the Copilot Chat panel (`⌃⌘I`)
2. Switch to **Agent** mode (dropdown at the top of the panel)
3. Open a Wolfbook notebook (`.wb`) and start the kernel
4. Ask anything — Copilot automatically has access to all Wolfbook tools

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
"Delete cells 12 and 15 — they are superseded by the new implementation"
"Undo those deletions — restore the last 2 deleted cells at the end of the notebook"
"Move cell 5 to after cell 12 — it belongs with that section"
"Run all cells from cell 3 to cell 20 and show me which ones fail"
"Restart the kernel then run all cells to verify the notebook runs clean from top to bottom"
"Save a kernel checkpoint before refactoring, then restore it if something breaks"
"Run all cells from 1 to 40, show me only the errors"
"Evaluate the matrix M using MatrixForm so I can see the layout"
"Search for a Wolfram package for working with cluster algebras"
"Check the kernel crash log — the kernel just died unexpectedly"
"What symbols have I defined so far? Show me the kernel state."
"Save the notebook after making these edits"
"Search for recent papers on quantum spectral curve by Gromov and get their BibTeX"
"Get the bibitem for arXiv:hep-th/0212208 and list all papers it cites"
"Find papers on SO(6) Heisenberg spin chain, then get citation contexts for the most cited one"
"List all open notebooks and switch to prototype.wb"
"Analyze the step structure of cell 4, set a breakpoint at line 6, then step through it"
"Add x and i to the watch list, then debug cell 3 and tell me what goes wrong"
```

You can also reference tools directly in your prompt:
- `#wolfbookSwitch` — list all open notebooks or switch to a specific one
- `#wolfbookContext` — read all notebook cells and outputs before asking a question
- `#wolfbookEval Integrate[1/(x^2+1), x]` — evaluate in the live kernel
- `#wolfbookLookup NDSolve` — look up usage, options, and documentation link
- `#wolfbookWebHelp NMinimize` — fetch the full online reference page
- `#wolfbookEdit` — replace the source of a cell (used automatically when Copilot fixes a cell)
- `#wolfbookRun` — re-run a cell and get its output (stores result in the notebook)
- `#wolfbookDelete` — remove one or more cells (recovery copies written to `ai_deleted_cells.md`)
- `#wolfbookRestore` — list or re-insert recently deleted cells from the recovery log
- `#wolfbookMove` — move a cell to a new position in the notebook
- `#wolfbookRunAll` — run a range of cells sequentially with per-cell output summary
- `#wolfbookState` — list all user-defined symbols and their current values
- `#wolfbookFindPkg` — search Wolfram Paclet Server + GitHub for packages
- `#wolfbookCrashLog` — read the kernel debug log or macOS crash reports
- `#wolfbookSaveNotebook` — persist the notebook to disk
- `#wolfbookDebug` — control the step-through debugger (analyze, start, step, breakpoints, watch list)
- `#wolfbookSearch` — search cells by text/regex/kind; returns matching cell numbers and content previews
- `#wolfbookReadFile` — read text files in the workspace (absolute or relative paths)
- `#wolfbookWriteFile` — write/create text files in the workspace (for non-notebook files)
- `#wolfbookPaper` — search academic papers on INSPIRE-HEP/arXiv; retrieve BibTeX/bibitem records, reference lists, and citation contexts
- `#wolfbookRunTerminal` — run shell commands with stdout/stderr capture
- `#wolfbookListFiles` — list files recursively with optional extension/depth filtering

Notebook safety rule for AI workflows:
- Never modify `.wb` notebook JSON directly via `#wolfbookWriteFile`.
- For notebook changes, always use notebook cell tools (`#wolfbookInsert`, `#wolfbookInsertMany`, `#wolfbookEdit`, `#wolfbookDelete`, `#wolfbookMove`, `#wolfbookRun`).

### Kernel safety

The tools are kernel-aware and safe to use at any time:
- **Kernel busy detection** — if a notebook cell is currently evaluating, `#wolfbookEval` and `#wolfbookLookup` refuse to dispatch and return a clear "kernel is busy" message instead of queuing a competing evaluation that could corrupt the WSTP link.
- **Dynamic widget awareness** — if `Dynamic[...]` widgets are active, evaluation tools note this but remain safe to use (Dynamic runs on a separate sub-channel).
- **Timeout abort** — if an evaluation exceeds `timeoutSeconds`, the kernel is cleanly interrupted via `session.abort()` so it is immediately ready for the next request.
- **Persistent action log** — `ai_eval_log.md` (in `img/<notebook>/`) records every expression Copilot evaluates, plus all cell edits, inserts, and deletes. Kernel restarts are marked with a `---` divider but the log is never cleared, so the full session history is preserved across reboots.

### WBExport — multi-format notebook export

Type `WBExport["filename.ext"]` in any code cell to export the current notebook. The output format is chosen by the file extension. The `WBExport` cell itself is always excluded from the export.

```wolfram
WBExport[]                      (* saves as <notebook-name>.nb next to the .wb file *)
WBExport["output.nb"]           (* Mathematica notebook *)
WBExport["output.pdf"]          (* PDF via Chrome headless *)
WBExport["output.html"]         (* self-contained HTML, all assets inlined *)
WBExport["output.md"]           (* Markdown; graphics saved to output_images/ *)
WBExport["output.tex"]          (* LaTeX article; graphics saved to output_images/ *)
WBExport["/absolute/path/out.pdf"]
```

**All formats:**
- **Never sent to the kernel** — intercepted by the extension like `WBInclude`.
- Exported with a **light background** using VS Code Light+ syntax colours.
- Every graphic output (SVG/PNG) is inlined or copied so exported files have no broken image links.

**Format details:**

| Format | Notes |
|--------|-------|
| `.nb` | Headings → `Title`/`Section`/etc.; text → `Text`; code → `Input`. Opens in Mathematica. |
| `.pdf` | Requires Google Chrome. KaTeX fonts inlined; math renders offline. |
| `.html` | Fully self-contained: KaTeX CSS+fonts, WL element CSS, and all images embedded as base64 data URIs. |
| `.md` | Code cells become ` ```mathematica ``` ` fenced blocks. Outputs with graphics are extracted to `<name>_images/` and referenced with `![output](...)`. Text outputs become blockquotes. |
| `.tex` | Full `\documentclass{article}` preamble with `amsmath`, `listings`, `graphicx`, `float`, `hyperref`. Code cells use `lstlisting` with a custom Mathematica language definition. Graphics saved to `<name>_images/` and included with `\includegraphics`. |

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

### WBVersion — version diagnostics

Evaluate `WBVersion[]` in any code cell to print a formatted summary of all running Wolfbook component versions:

```wolfram
WBVersion[]
```

Sample output (plain `Print[]` lines in the cell output):

```
Wolfbook extension : 2.6.20  (installed: 2026-04-06)
BTL (box-to-LaTeX) : 2.2.3   (built: 2026-04-06)
WSTP addon         : 1.1.3   (built: 2026-04-06)
Mathematica kernel : 14.1.0 for Mac OS X ARM (64-bit) (January 2, 2024)
```

- **Extension version** — read from `package.json`; the install date is the mtime of that file (changes on each VSIX update).
- **BTL / WSTP build date** — embedded at C++ compile time; reflects when the binary was built, independent of when the extension was installed.
- Output bypasses all rendering pipelines (no LaTeX/HTML processing) and always appears as readable plain text even for complex kernel configurations.

---

### Cell-level CRUD

Copilot has full read/write/delete access to notebook cells — not just the ability to append new ones:

- **`#wolfbookEdit`** replaces the source of any existing cell. Pass `evaluate:true` to run the updated content immediately and have the result returned to Copilot for verification.
- **`#wolfbookRun`** executes an existing cell through the standard Wolfbook pipeline. Unlike `#wolfbookEval`, the result is stored as the cell's output in the notebook (visible in the editor), not just returned to the chat.
- **`#wolfbookDelete`** removes one or more cells. Pass `cellNumber` for a single cell or `cellNumbers` (array) for multiple; cells are removed in descending index order. Before each deletion the source is appended to `img/<notebook>/ai_deleted_cells.md` so nothing is permanently lost.
- **`#wolfbookRestore`** re-inserts recently deleted cells from the recovery log. Use `action:"list"` to browse the last N deletions (with timestamps and content previews) and `action:"restore"` to re-insert them at any notebook position. The recovery log is never cleared.
- **`#wolfbookMove`** reorders a cell atomically: delete from the old position and re-insert at the new one in a single `WorkspaceEdit`. Use `toPosition:0` to move a cell to the very beginning, or `toPosition:N` to place it after Cell N.
- **`#wolfbookRunAll`** runs a range of cells (default: all) sequentially, waiting for each to finish before starting the next. Returns a per-cell status and output summary. Ideal for clean-run validation after a kernel restart: restart the kernel, then ask Copilot to run all cells.
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
- **Smart bracket selection** — `⌃⇧→` / `Alt+Shift+Right` progressively expands the selection through Wolfram Language bracket levels, Mathematica-style. Starting from the cursor, each press widens the selection to the next enclosing scope: word → comma-separated argument → bracketed group → head + brackets → outer expression → …. Works with all bracket types (`[…]`, `[[…]]`, `{…}`, `(…)`) and correctly handles strings, comments, and nested structures.
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
- **Code folding** — fold/unfold any bracket pair that spans multiple lines: `( )`, `[ ]`, `{ }`, `[[ ]]`, `<| |>`, and `(* *)` comments.  Closing-bracket lines are always kept visible so structure is clear at a glance.  Works in `.wb` / `.evsnb` notebooks and standalone `.wl` / `.wls` files.
- **WL code formatter** — press `Alt+Shift+F` (or enable `wolfbook.formatter.autoFormat`) to format the current cell.  The formatter is bracket-depth-aware and preserves strings and comments.  Inline comments (e.g. `x = 1;(*comment*)`) are moved to their own line; blank lines around standalone comments are preserved; trailing newlines are kept as-is.
- **Paste image as cell** *(macOS only)* — copy any image to the clipboard, then:
  - `⌘V` with a cell selected (but not in edit mode) — inserts the image immediately as a new Markdown cell below
  - `⌘⇧V` anywhere in the notebook — shows a prompt to insert the image above or below the current cell

  Images are saved as PNGs inside `img/<notebook-name>/` next to the notebook and garbage-collected automatically when their cells are deleted.

---

## ⌨️ Keyboard Shortcuts

A complete reference for all keyboard shortcuts in Wolfbook notebooks (`.evsnb`).

| Action | macOS | Windows / Linux |
|---|---|---|
| **Execute cell** | `Shift+Enter` | `Shift+Enter` |
| **Insert code cell above** *(enters edit mode)* | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| **Insert code cell below** *(enters edit mode)* | `Cmd+Shift+B` | `Ctrl+Shift+B` |
| **Delete current cell** | `Cmd+Shift+X` | `Ctrl+Shift+X` |
| **Evaluate selection** | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| **Add selection to Watch panel** | `Cmd+Shift+W` | `Ctrl+Shift+W` |
| **Debug cell (step-by-step)** | `Cmd+Shift+D` | `Ctrl+Shift+D` |
| **Expand selection (smart bracket select)** | `⌃⇧→` | `Alt+Shift+Right` |
| **Shrink selection** | `⌃⇧←` | `Alt+Shift+Left` |
| **Paste image as cell below** | `Cmd+Shift+V` | — |
| **Enter alias mode** (type `alpha` → `α`, etc.) | `Esc` | `Esc` |
| **Jump to cell above** (command mode) | `←` | `←` |
| **Jump to cell below / create new** (command mode) | `→` | `→` |

> All notebook-specific shortcuts are active only when a wolfbook `.evsnb` file is open.

---

## 🖼 Wolfbook Slides (`.wslide`)

Wolfbook includes a full slide-deck editor for `.wslide` files — a presentation format designed for scientific talks with LaTeX math, fragment animations, and GitHub Copilot integration.

See **[WSLIDE_README.md](WSLIDE_README.md)** for the complete reference, including:
- File format and JSON schema
- All block types (heading, text, image, list, container, arrow, raw HTML)
- Canvas coordinate system and positioning model
- Animation (fragment step) system
- Presentation mode and HTML export
- AI Copilot tools (`wolfslide_*`) with example prompts and ASCII layout output format

---

## 🧪 MCP Server — Claude Code, Codex & Claude Desktop *(Experimental)*

Wolfbook exposes all its notebook tools to external AI CLI agents via the **Model Context Protocol (MCP)**. This is configured automatically when the extension activates — no manual steps needed.

### What is configured

The extension writes the wolfbook MCP entry to three config files on startup:

| Client | Config file | Notes |
|--------|-------------|-------|
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` | macOS only |
| **Claude Code CLI** | `~/.claude.json` (per workspace) | Project-scoped entry |
| **Codex CLI** | `~/.codex/config.toml` | Global `[mcp_servers.wolfbook]` |

### How it works

The extension runs a lightweight HTTP/SSE MCP server on a local port (27182–27202). External AI clients connect via a stdio bridge script that is spawned automatically — the bridge polls until VS Code is ready (up to 60 s), so there is no startup timing race.

When Claude Code or Codex starts, it connects to the bridge and gains access to all 45 Wolfbook tools: read notebook cells, evaluate expressions, insert/edit/delete cells, control the kernel, debug, search papers, and more.

### Trigger manual reconfiguration

If the automatic write fails (e.g. config was corrupt), run:

```
> Wolfbook: Configure Claude & Codex MCP
```

from the VS Code Command Palette (`⌘⇧P`). This re-writes all three config files and prompts you to restart the AI client.

### Notes

- **Experimental** — MCP tool schema restrictions vary by client; some advanced parameter constraints are stripped to maintain compatibility.
- **Multi-window**: if multiple VS Code windows are open, the first window to claim port 27182 serves all clients.
- **New workspaces**: when you open a new folder, its path is automatically added to `~/.claude.json`. Restart Claude Code to pick it up.

---

## Requirements

- [Wolfram Mathematica](https://www.wolfram.com/mathematica/) or [Wolfram Engine](https://www.wolfram.com/engine/) installed locally
- VS Code 1.95+
- The bespoke **WSTP connector** (`wstp.node`) — a native Node.js addon that connects directly to the Wolfram kernel via the WSTP protocol. Prebuilt for **macOS Apple Silicon** (arm64), **macOS Intel** (x64), and **Windows x64**.
- The bespoke **wolfbook-btl** addon (`wolfbook_btl.node`) — a native C++ addon that translates Wolfram `TraditionalForm` box structures to LaTeX. Prebuilt for **macOS Apple Silicon**, **macOS Intel**, **Windows x64**, and **Linux x64**.
- **Wolfram Engine** is fully supported. On machines where the Engine licence allows only a single concurrent kernel process, Wolfbook automatically falls back to rendering via the main kernel instead of launching a second one — Evaluate Selection and Dynamic widgets both work correctly.

Both native addons are bundled inside the `.vsix` so no separate build step is needed.

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
