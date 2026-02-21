# Wolfbook — Wolfram Language Notebook for VS Code

**Wolfbook** is a VS Code extension that turns `.evsnb` / `.vsnb` files into interactive Wolfram Language notebooks, backed by a live kernel connected via native [WSTP](https://github.com/vanbaalon/mathematica-wstp-node).

> Author: Nikolay Gromov — [nikolay.gromov@kcl.ac.uk](mailto:nikolay.gromov@kcl.ac.uk)  
> License: Apache 2.0 (see [LICENSE.txt](LICENSE.txt))

---

## Features

### Key improvements over the official extension

- **Mid-evaluation abort** — interrupt a running computation at any time via the toolbar or `Abort` command; the kernel recovers cleanly and is immediately ready for new input. The official extension does not support this.
- **Dialog[] / subsession evaluation** — when a computation calls `Dialog[]`, `Input[]`, or `DialogInput[]`, a live input widget appears inside the notebook. You can evaluate expressions in the subsession context and return values back to the suspended computation. This mirrors the interactive subsession behaviour of the Wolfram Desktop.
- **Rich rendering pipeline** — results are rendered as **SVG** (for `Graphics`, plots, and all visual objects), **MathML** (for symbolic and algebraic expressions), or **PNG** as fallback, all via a dedicated Wolfram rendering layer (`VsCodeRender`). The official extension renders only plain text or basic HTML.

---

### Interactive Notebook
- **WSTP kernel backend** — connects directly to a local Wolfram/Mathematica kernel via the native [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node) addon (no ZeroMQ, no subprocess piping)
- **MathML, SVG, PNG, HTML and InputForm** output rendering — switchable per session
- **Out[N]= labels** with session tracking — labels clear automatically on kernel restart
- **Print[] output** rendered as preformatted text, interleaved with results
- **Kernel messages** (warnings, errors) shown inline in amber
- **Truncated output** for large results — "Expand" and "Open as text" controls
- **Wrap / Scroll toggle** button on wide MathML outputs
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
