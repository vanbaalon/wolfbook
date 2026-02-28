# Wolfbook — Wolfram Language Notebook for VS Code

<p align="center">
  <img src="images/wolfbook_logo.png" alt="Wolfbook logo" width="320"/>
</p>

**Wolfbook** is a VS Code extension that turns `.evsnb` / `.vsnb` files into interactive Wolfram Language notebooks, backed by a live kernel connected via native [WSTP](https://github.com/vanbaalon/mathematica-wstp-node).

> Author: Nikolay Gromov — [nikolay.gromov@kcl.ac.uk](mailto:nikolay.gromov@kcl.ac.uk)  
> License: Apache 2.0 (see [LICENSE.txt](LICENSE.txt))

---

## Features

### Key improvements over the official extension

- **Mid-evaluation abort** — interrupt a running computation at any time via the toolbar or `Abort` command; the kernel recovers cleanly and is immediately ready for new input. The official extension does not support this.
- **Dialog[] / subsession evaluation** — when a computation calls `Dialog[]`, `Input[]`, or `DialogInput[]`, a live input widget appears inside the notebook. You can evaluate expressions in the subsession context and return values back to the suspended computation. This mirrors the interactive subsession behaviour of the Wolfram Desktop. The `closeAllDialogs()` WSTP method guarantees reliable cleanup of dialog state even in error or abort scenarios.
- **Rich rendering pipeline** — results are rendered as **SVG** (for `Graphics`, plots, and all visual objects), **MathML** (for symbolic and algebraic expressions), or **PNG** as fallback, all via a dedicated Wolfram rendering layer (`VsCodeRender`). The official extension renders only plain text or basic HTML.
- **Smart two-mode evaluation scroll** — pressing Shift+Enter automatically chooses the optimal scroll behaviour depending on whether the cell was edited:
  - **Advance mode** (unchanged cell) — the evaluated cell scrolls to the top of the viewport the moment you press Shift+Enter, before output arrives. Output fills in below without any further viewport jump. Focus advances to the next cell so you can keep evaluating.
  - **Refine mode** (cell was edited since last run) — the viewport stays completely still. Focus returns to the same cell in edit mode with the cursor restored, so you can immediately continue editing. Use this mode when iterating on a single cell.
  - Auto-detection works on first run too: if you edit a fresh cell before ever running it, it correctly enters Refine mode. The active mode is shown in the status bar (bottom-right) and can be forced with the toolbar button.

---

### Interactive Notebook
- **WSTP kernel backend** — connects directly to a local Wolfram/Mathematica kernel via the native [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node) addon (no ZeroMQ, no subprocess piping)
- **MathML, SVG, PNG, HTML and InputForm** output rendering — switchable per session
- **Out[N]= labels** with session tracking — labels clear automatically on kernel restart
- **Print[] output** rendered as preformatted text, interleaved with results
- **Kernel messages** (warnings, errors) shown inline in amber
- **Per-cell output format buttons** — each output header shows format buttons to switch rendering on the fly; the chosen format is remembered per cell for the session. Two button sets are shown depending on output type:
  - **Graphics outputs** (plots, `Graphics[…]`, images): **WL** (InputForm text) | **SVG** (rasterized image) | **TikZ** (TikZ source code for LaTeX documents)
  - **Symbolic/expression outputs**: **WL** (InputForm text) | **SVG** (rasterized image) | **TeX** (KaTeX-rendered LaTeX, pre-rendered in extension host) | **src** (raw LaTeX source) | **LaTeX** (KaTeX pre-rendered, identical UI to TeX but uses a different rendering path) | **LaTeX2** (raw LaTeX sent to webview, rendered by KaTeX in browser) | **∑** (MathML)
- **LaTeX rendering** — two modes are available for symbolic expressions:
  - *TeX / LaTeX*: `MakeBoxes[expr, TraditionalForm]` calls a native C++ `boxToLatex` addon (WolfbookLaTeX) to produce a LaTeX string; KaTeX pre-renders it to HTML in the extension host; the finished HTML is delivered to the webview for instant display with no runtime JS dependency.
  - *LaTeX2*: same box-to-LaTeX path, but the raw LaTeX string is sent to the webview and rendered client-side by `katex.min.js` bundled with the extension. Useful as a fallback if the pre-rendered version looks wrong.
  - Both modes show a **debug disclosure** widget (fold-out) with the raw Wolfram boxes, the raw LaTeX string, and any error from the addon.
  - If `boxToLatex` returns an error (e.g. unsupported box structure), a ⚠️ warning banner appears above the output and the error is shown in the debug section.
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
- The prebuilt `wstp.node` addon (macOS included; see [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node) to build for other platforms)

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
