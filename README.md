# Wolfbook — AI-Friendly Wolfram Language Notebook

<p align="center">
  <img src="images/wolfbook_logo.png" alt="Wolfbook logo — Mathematica-style notebooks for VS Code" width="120"/>
</p>

<p align="center">
  <a href="docs/getting-started.md">Get Started</a> ·
  <a href="docs/features.md">Features</a> ·
  <a href="docs/ai-integration.md">AI Integration</a> ·
  <a href="docs/mcp-and-agent-tools.md">MCP & Agent Tools</a> ·
  <a href="docs/using_cline.md">Using Cline</a> ·
  <a href="docs/deepseek-copilot.md">DeepSeek + Copilot</a> ·
  <a href="docs/presentations.md">Presentations (.wslide)</a> ·
  <a href="docs/best-practices.md">Best Practices</a> ·
  <a href="docs/wb-functions.md">WB Functions</a> ·
  <a href="#citing-wolfbook">Citing</a>
</p>

Wolfbook is a Mathematica notebook frontend for VS Code. It lets you create, edit and run Wolfram Language notebooks using a local Wolfram Engine or Mathematica kernel — with rich LaTeX and graphics output, a live kernel that AI agents can call, and plain-text notebooks that work with Git.

<p align="center">
  <img src="docs/screenshot-debugger.png" alt="Mathematica-style Wolfram Language notebook in VS Code with live kernel evaluation, LaTeX typesetting, graphics output and debugger breakpoint" width="80%" />
</p>

---

## Why Wolfbook?

- A real Mathematica notebook inside VS Code, not just syntax highlighting
- Works with **Wolfram Engine** (free) or **Mathematica**
- Plain-text `.wb` / `.vsnb` notebooks — **diffable in Git**, readable by AI tools
- Rich math output: **LaTeX / KaTeX**, **SVG / PNG graphics**,  **TikZ**
- **Live kernel access for AI agents** — Copilot, Claude Code, Codex, MCP-compatible tools
- **Mid-evaluation abort**, **Dynamic[]** widgets, debugger and watch panel
- Open source, Apache 2.0

---

## Wolfbook vs other Wolfram/Mathematica VS Code extensions

| Feature | Wolfbook | Official Wolfram extension | Wolfram Language Notebook |
|---|---|---|---|
| Wolfram Language syntax highlighting | ✓ | ✓ | ✓ |
| Mathematica-style notebook UI | ✓ | basic | ✓ |
| Live Wolfram kernel via WSTP | ✓ | — | wolframscript |
| Rich LaTeX / KaTeX rendering | ✓ | — | partial |
| Inline SVG / PNG / TikZ graphics | ✓ | static | basic |
| Mid-evaluation abort | ✓ | — | — |
| Dynamic[] widgets | ✓ | — | — |
| AI agents can evaluate cells (MCP / Copilot) | ✓ | — | — |
| Plain-text notebook format (Git-friendly) | ✓ | ✓ | ✓ |
| Open source | ✓ | ✓ | ✓ |

---

## Screenshots

![Live variable watch panel and mid-evaluation selection in a Wolfram Language notebook](docs/screenshot-watchpanel.png)
*Live watch of variables and mid-evaluation evaluate-selection feature — inspect expressions without Print statements, all while the kernel is running.*

![Rich symbolic output rendered as LaTeX via KaTeX, with adaptive line-breaking and matrix pagination](docs/screenshot-latex.png)
*Symbolic Mathematica output typeset with LaTeX via KaTeX. Adaptive line-breaking and matrix paging make even huge expressions readable.*

![An AI agent calling Wolfbook's kernel tools: $Aport, Wolfram Language documentation lookup, and cell evaluation](docs/screenshot-aport.png)
*An AI agent using Wolfbook's MCP tools — calling `$Aport`, looking up documentation, evaluating cells in the live Wolfram kernel.*

![Claude Code agent evaluating a Mathematica cell through the Wolfbook MCP server](docs/screenshot-ai.png)
*An AI agent (Claude Code / Copilot / MCP-compatible) evaluating cells and inspecting results in a live Wolfram kernel.*

![Inline graphics rendering: plots and SVG output from a Wolfram kernel inside a VS Code notebook](docs/screenshot-graphics.png)
*AI agents can read your notebook content in an AI-friendly format, assist you in writing code, or solve mathematical problems from start to end with full numerical and analytic verification — producing a clean notebook for your inspection, debugging errors, and summarizing main findings. You can then export results to your LaTeX documents with ease, either using AI agents or manually.*

---

## What You Get

### A proper notebook in VS Code

- `.wb` files with code cells and Markdown cells (with full LaTeX math via KaTeX)
- Symbolic results rendered as typeset mathematics with line-broken LaTeX — not plain text
- Graphics (plots, `Graphics[…]`) rendered as SVG or PNG inline
- Per-cell output format switching: WL / SVG / LaTeX / MathML / TikZ
- `Dynamic[expr]` widgets that update live while the kernel runs
- Abort the kernel without losing your kernel context, or restart with a clean kernel with one click — exactly like in Mathematica, but unique among VS Code notebook extensions
- Escape-mode Greek entry: type `\[Alpha]`, `\[Beta]`, `\[Gamma]` and they get converted into symbols, or use [escape]a[escape] etc.
- Watch any expression continuously; evaluate any selection mid-computation

### VS Code IDE features — free

- Split view: open two notebooks side by side
- Multi-cursor: rename all occurrences of a symbol at once
- Step-by-step debugger: set breakpoints, step over/into loops, inspect variables
- Live Watch Panel: monitor expressions across evaluations without Print statements
- Full git integration: diff, blame, branch — works because `.wb` is plain text

### AI that actually knows your notebook

Wolfbook exposes your live kernel and notebook contents to AI agents via purpose-built tools. GitHub Copilot in Agent mode can, for example:

- Read all cells and their outputs (`#wolfbookContext`)
- Evaluate any expression in the live kernel (`#wolfbookEval`)
- Look up Wolfram documentation without a browser (`#wolfbookLookup`)
- Insert, edit, and delete cells (`#wolfbookInsert`, `#wolfbookEdit`, `#wolfbookDelete`)
- Drive the step-through debugger autonomously (`#wolfbookDebug`)
- Query the kernel state — what symbols are defined, what are their values (`#wolfbookState`)

The same tools are exposed as an **MCP (Model Context Protocol) server**, so any MCP-compatible AI agent — Claude Code, Codex, and others — can use them too. See [MCP & Agent Tools](docs/mcp-and-agent-tools.md) for details.

### Presentations built in your notebook

Wolfbook includes a `.wslide` presentation format: JSON-based slides rendered via Reveal.js inside VS Code, with LaTeX math, live Wolfram Language eval blocks, and the same btl math renderer as the notebook. The entire slide format is editable by AI agents via 12 dedicated MCP tools. See [Presentations](docs/presentations.md). Drop your pictures and a bit of text and get a full slide deck in seconds. Refine it with AI and create a masterpiece.

---

## Quick Start

**1. Install prerequisites**

- [VS Code](https://code.visualstudio.com) 1.95+ / [Antigravity](https://antigravity.ai)
- [Wolfram Engine](https://wolfram.com/engine) (free, non-commercial) or Mathematica
- Activate Wolfram Engine at [wolfram.com/engine/free-license](https://wolfram.com/engine/free-license) — requires internet once

**2. Install Wolfbook**

Wolfbook can be found in the VS Code Marketplace or on GitHub in the [Releases](https://github.com/vanbaalon/wolfbook/releases) section. Or on Antigravity's marketplace or [open-vsx.org](https://open-vsx.org/).

**3. Create your first notebook**

Create an empty file `test.wb` and open it in VS Code. The kernel starts automatically on first cell execution.

**4. Enable AI (optional but recommended)**

Install GitHub Copilot from the Extensions panel (free tier available; GitHub Education gives generous limits). Open the Copilot Chat panel (`⌃⌘I`), switch to **Agent** mode, and start asking. From our experience Claude Code in Agent mode gives the best result.

→ Full setup guide: [Getting Started](docs/getting-started.md)

---

## Architecture

Wolfbook is built around two bespoke native C++ addons:

**`mathematica-wstp-node`** — connects directly to the Wolfram kernel via the WSTP (Wolfram Symbolic Transfer Protocol) protocol. No subprocess piping, no ZeroMQ. This is what makes mid-evaluation abort, Dynamic widgets, and Dialog[] subsessions possible.

**`wolfbook-btl`** (Box-to-LaTeX) — translates Wolfram's internal `TraditionalForm` box structures to LaTeX, rendered client-side with KaTeX. About 10× faster than Wolfram's built-in `TeXForm` for complex expressions, and handles many cases TeXForm cannot. Dynamically adjusts line-breaking to fit the page width. Long expressions are paginated or can be exported in one click in `.wl` format.

Both addons are prebuilt for macOS (Apple Silicon and Intel) and Windows and bundled in the `.vsix`. Linux is under construction. You can also compile them yourself; see [Building from Source](docs/building.md).

---

## Documentation

| Document | What it covers |
|---|---|
| [Getting Started](docs/getting-started.md) | Installation, first notebook, setup checklist |
| [AI Integration](docs/ai-integration.md) | GitHub Copilot agent tools — full reference |
| [MCP & Agent Tools](docs/mcp-and-agent-tools.md) | Using Wolfbook with Claude Code, Codex, and other MCP clients |
| [Features](docs/features.md) | Notebook interface, kernel control, editor, debugger, Dynamic |
| [Presentations (.wslide)](docs/presentations.md) | The AI-native slide format |
| [DeepSeek + Copilot](docs/deepseek-copilot.md) | Using DeepSeek models with VS Code Copilot |
| [Best Practices](docs/best-practices.md) | How to work effectively with the agent |
| [Building from Source](docs/building.md) | Compile the native addons, package the extension |
| [WB Functions](docs/wb-functions.md) | Custom WL functions: WBVersion, WBDirectory, WBPrint, WBInclude, WBExport, WBPrompt |

---

## Status and Feedback

Wolfbook is just over a month old (first release: March 2026). It works well for the use cases demonstrated at the CERN workshop, but rough edges remain. If you encounter a bug or unexpected behaviour, please **report it via the [GitHub issue tracker](https://github.com/vanbaalon/wolfbook/issues)** — include your OS, VS Code version, Wolfram Engine / Mathematica version, and a minimal code or screenshots that reproduces the problem. We will try to fix issues as quickly as possible.

Feature requests and pull requests are also very welcome.

## Citing Wolfbook

If Wolfbook supports your research, a brief mention in the acknowledgements helps us track impact and sustain development:

> *"Some computations in this work were facilitated by the Wolfbook VS Code extension (github.com/vanbaalon/wolfbook)."*

---

## Links

- GitHub: [github.com/vanbaalon/wolfbook](https://github.com/vanbaalon/wolfbook)
- WSTP addon: [github.com/vanbaalon/mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node)
- Wolfram Engine (free): [wolfram.com/engine](https://wolfram.com/engine)

**Author:** Nikolay Gromov, King's College London — nikolay.gromov@kcl.ac.uk  
**License:** Apache 2.0

> Wolfbook is an independent open-source project, not affiliated with or endorsed by Wolfram Research Inc. "Wolfram", "Mathematica", and "Wolfram Language" are trademarks of Wolfram Research Inc.

## Acknowledgements 

Wolfbook was heavily inspired by and initially based on the official `vscode-wolfram` extension by Wolfram Research Inc. (Apache 2.0). The LSP client layer and kernel-finding logic originate from that project. The notebook frontend and the entire kernel backend have since been rewritten from scratch.

