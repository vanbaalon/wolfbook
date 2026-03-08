# Wolfbook — Wolfram Language Notebook for VS Code

<p align="center">
  <img src="images/wolfbook_logo.png" alt="Wolfbook logo" width="320"/>
</p>

**Wolfbook** is a VS Code extension that turns `.wb` / `.evsnb` / `.vsnb` files into interactive Wolfram Language notebooks, backed by a live kernel connected via a bespoke native WSTP (Wolfram Symbolic Transfer Protocol) connector — no subprocess piping, no ZeroMQ.

> Author: Nikolay Gromov — [nikolay.gromov@kcl.ac.uk](mailto:nikolay.gromov@kcl.ac.uk)  
> License: Apache 2.0 (see [LICENSE.txt](LICENSE.txt))

---

## 🤖 GitHub Copilot Integration

**Wolfbook is the first Wolfram Language notebook with deep GitHub Copilot agent integration.**

Switch Copilot to **Agent mode** and it gains live access to your running kernel: it can read your entire notebook, run expressions, look up documentation, and insert new cells — all without leaving VS Code.

### What Copilot can do with Wolfbook

| Tool | Reference | What Copilot can do |
|------|-----------|---------------------|
| 📋 **Get notebook context** | `#wolfbookContext` | Reads all cells and their outputs — Copilot sees exactly what you've computed |
| ⚡ **Evaluate expression** | `#wolfbookEval` | Runs any Wolfram Language expression in your live kernel and gets the result back |
| 🔍 **Look up symbol** | `#wolfbookLookup` | Retrieves full usage docs, options table, and a link to the online reference for any symbol — built-in or user-defined |
| 🌐 **Full web help** | `#wolfbookWebHelp` | Fetches and returns the complete Wolfram reference page for a built-in symbol — examples, details, and all |
| ➕ **Insert cell** | `#wolfbookInsert` | Adds a new code or markdown cell at any position in your notebook |

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
```

You can also reference tools directly in your prompt:
- `#wolfbookContext` — read all notebook cells and outputs before asking a question
- `#wolfbookEval Integrate[1/(x^2+1), x]` — evaluate in the live kernel
- `#wolfbookLookup NDSolve` — look up usage, options, and documentation link
- `#wolfbookWebHelp NMinimize` — fetch the full online reference page

### Kernel safety

The tools are kernel-aware and safe to use at any time:
- **Kernel busy**: if a notebook cell is currently evaluating, the tools return a clear "kernel is busy" message and wait for you to press **Abort** or let the cell finish — no risk of corrupting the WSTP link
- **Dynamic widgets**: if `Dynamic[...]` loops are active, evaluation still works safely (Dynamic uses a separate Dialog sub-session path that doesn't interfere)
- **Timeout**: if a tool evaluation times out, the kernel is automatically interrupted to prevent a stale result from interfering with subsequent evaluations

---

## Features

### Key improvements over the official extension

- **Mid-evaluation abort** — interrupt a running computation at any time via the toolbar or `Abort` command; the kernel recovers cleanly and is immediately ready for new input. The official extension does not support this.
- **Dialog[] subsession support** — Wolfbook uses `Dialog[]` subsessions internally to power the Dynamic widget system: when the kernel is busy, it is briefly interrupted into a `Dialog[]` context to evaluate live widget expressions, then immediately resumed. The `closeAllDialogs()` WSTP method guarantees reliable cleanup of all dialog state on abort or restart, preventing the kernel from getting stuck in a subsession. Note: a user-facing interactive input widget for when WL code calls `Input[]` or `DialogInput[]` directly is not yet implemented.
- **Rich rendering pipeline** — results are rendered as **SVG** (for `Graphics`, plots, and all visual objects), **MathML** (for symbolic and algebraic expressions), or **PNG** as fallback, all via a dedicated Wolfram rendering layer (`VsCodeRender`). The official extension renders only plain text or basic HTML.
- **Smart two-mode evaluation scroll** — pressing Shift+Enter automatically chooses the optimal scroll behaviour depending on whether the cell was edited:
  - **Advance mode** (unchanged cell) — the evaluated cell scrolls to the top of the viewport the moment you press Shift+Enter, before output arrives. Output fills in below without any further viewport jump. Focus advances to the next cell so you can keep evaluating.
  - **Refine mode** (cell was edited since last run) — the viewport stays completely still. Focus returns to the same cell in edit mode with the cursor restored, so you can immediately continue editing. Use this mode when iterating on a single cell.
  - Auto-detection works on first run too: if you edit a fresh cell before ever running it, it correctly enters Refine mode. The active mode is shown in the status bar (bottom-right) and can be forced with the toolbar button.

---

### Dynamic Widgets

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

**Same-cell early-start** — if `Dynamic[expr]` comes before other sub-expressions in the same cell, the widget loop starts *immediately* when the placeholder is placed, before the remaining sub-expressions run:
```wolfram
Dynamic[n, LiveEvaluations -> 2]    (* slot 0: live n during the loop *)
Do[n = k; Pause[0.5], {k, 1, 20}]  (* slot 1: loop output *)
```

The render subkernel is prewarmed as soon as the first `Dynamic` is registered, so the first render has no cold-start delay.

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
  - *LaTeX*: uses `MakeBoxes[expr, TraditionalForm]` to extract the Wolfram box structure, passes it through the bespoke **wolfbook-btl** C++ addon (`boxToLatex`), sends the resulting LaTeX to the webview and renders it client-side with KaTeX. This path has several concrete advantages over the built-in `TeXForm`:

    **Colour and style support** — Wolfram's `TeXForm` strips all styling. wolfbook-btl preserves it: `StyleBox[expr, FontColor->RGBColor[1,0,0]]` yields `\textcolor{#ff0000}{…}`; bold → `\mathbf{…}`; italic → `\mathit{…}`. All colour models are supported: `RGBColor[r,g,b]`, `GrayLevel[g]`, `Hue[h,s,b]`, `CMYKColor[c,m,y,k]`, and 20 named colours (`Red`, `Blue`, `Orange`, `Purple`, …). Nesting order follows KaTeX expectations: colour innermost, bold outermost.

    **Correct large-operator limits** — `UnderoverscriptBox` and `UnderscriptBox`/`OverscriptBox` detect whether the base is a large operator (∑ `\sum`, ∏ `\prod`, ∫ `\int`, ∮ `\oint`, ⋃ `\bigcup`, etc.) and emit `_{…}^{…}` subscript/superscript limits rather than `\underset{}`/`\overset{}`, which is what KaTeX expects for displayed summation limits.

    **Correct matrix environments** — `RowBox` with a surrounding delimiter pair wrapping a `GridBox` maps to the right LaTeX environment: `()` → `pmatrix`, `[]` → `bmatrix`, `{}` → `Bmatrix`, `|…|` → `vmatrix`, `‖…‖` → `Vmatrix`. A bare `GridBox` with a `ColumnAlignments` option becomes an `aligned` environment rather than a plain matrix. `TeXForm` produces flat text for all of these.

    **Piecewise functions** — `TagBox[GridBox[…], "Piecewise"]` → `\begin{cases}…\end{cases}` with proper `&` column separators.

    **TemplateBox support** — handles `Sqrt` → `\sqrt{…}`, `Abs` → `\left|…\right|`, `Norm` → `\left\|…\right\|`, and `Superscript`/`Subscript`/`Fraction` templates.

    **Performance** — the addon is a C++17 N-API module. The parser is single-pass O(n) with a flat arena-allocated AST (no per-node heap allocation, no virtual calls). Named-character lookup (`\[Alpha]`, `\[Infinity]`, etc.) is O(1) average via an `std::unordered_map` over 880+ entries. The result `std::string` is pre-reserved and moved out without copying. For large or deeply-nested expressions this is significantly faster than the Wolfram-side `TeXForm` evaluation.
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

## Notebook Format

Wolfbook uses `.evsnb` (extended) and `.vsnb` files — JSON-based VS Code notebook format. The `.evsnb` format extends `.vsnb` with per-cell metadata (output format, scale, etc).

---

## Acknowledgements

Wolfbook was heavily inspired by and initially based on the official [vscode-wolfram](https://github.com/WolframResearch/vscode-wolfram) extension by Wolfram Research Inc. (Apache 2.0). The LSP client layer and kernel-finding logic originate from that project. The notebook frontend and the entire kernel backend have since been rewritten from scratch.

The WSTP native addon is a separate project: [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node).

---

**Disclaimer:** Wolfbook is an independent open-source project and is not affiliated with, endorsed by, or supported by Wolfram Research Inc. "Wolfram", "Mathematica", and "Wolfram Language" are trademarks of Wolfram Research Inc.

---
