# Wolfbook — AI-Native Mathematica Notebooks for VS Code

<p align="center">
  <img src="images/wolfbook_logo.png" alt="Wolfbook logo" width="120"/>
</p>

<p align="center">
  <strong>Wolfram Language notebooks with full AI agent integration, rich LaTeX rendering and abortable evaluation with step-by-step debugging and live watch panel.</strong>
</p>

<p align="center">
  <a href="docs/getting-started.md">Get Started</a> ·
  <a href="docs/ai-integration.md">AI Integration</a> ·
  <a href="docs/features.md">Features</a> ·
  <a href="docs/mcp-and-agent-tools.md">MCP & Agent Tools</a> ·
  <a href="docs/using_cline.md">Using Cline</a> ·
  <a href="docs/presentations.md">Presentations (.wslide)</a> ·
  <a href="docs/best-practices.md">Best Practices</a> ·
  <a href="#citing-wolfbook">Citing</a>
</p>

---

## What is Wolfbook?

Wolfbook is a VS Code extension that gives you interactive **Wolfram Language notebooks** (`.wb` files) directly in your editor — with none of the limitations of the standard Mathematica frontend.

You get a notebook interface that renders symbolic math and graphics with high-quality typesetting, a live kernel connection via a bespoke native WSTP connector, and — crucially — **full integration with VS Code's/Antigravity's AI ecosystem**: GitHub Copilot, CODEX, Claude Code, and Antigravity can read your notebook, evaluate expressions, look up documentation, insert and edit cells, and drive the step-by-step debugger, all without leaving your workspace. All this together gives you the power of Mathematica with the flexibility of VS Code and constitutes unique workflow with the agility of AI and precision of Mathematica. Producing verifiable and reproducible analysis of your computational problems becomes a breeze. You can finally benefit from the latest development in AI tools without sacrifising the robust and proven Wolfram Language computational engine.

Wolfbook is **free and open source**. It works with the free [Wolfram Engine](https://wolfram.com/engine) — no Mathematica licence required.

---

## Why Wolfbook?

Standard Mathematica is powerful but isolated. Its `.nb` format is binary — you cannot `git diff` it. There is no split view, no multi-cursor, no extension ecosystem, and AI integration is chat-only: the AI cannot call the kernel, read your notebook state, or insert cells. Even if you have a Mathematica license, you still pay extra for LLM access, and you can't use other AI tools like Copilot or Claude Code. Wolfbook works with both Mathematica and Wolfram Engine and connects you to all standard AI tools like GitHub Copilot, CODEX, Claude Code, and Antigravity with MCP (Model Context Protocol) and .wb (Wolfbook) format which is plain text and can be version controlled.

---

## What You Get

### A proper notebook in VS Code

- `.wb` files with code cells and Markdown cells (with full LaTeX math via KaTeX)
- Symbolic results rendered as typeset mathematics with line breaked LaTeX — not plain text
- Graphics (plots, `Graphics[…]`) rendered as SVG or PNG inline
- Per-cell output format switching: WL / SVG / LaTeX / MathML / TikZ
- `Dynamic[expr]` widgets that update live while the kernel runs
- Abort the kernel without losing your kernel context, or restart with a clean kernel with one click or with a shortcut (still impossible in Mathematica!)
- Watch any expression continuously; evaluate any selection mid-computation

### VS Code IDE features — free

- Split view: open two notebooks side by side
- Multi-cursor: rename all occurrences of a symbol at once
- Step-by-step debugger: set breakpoints, step over/into loops, inspect variables
- Live Watch Panel: monitor expressions across evaluations without Print statements
- Full git integration: diff, blame, branch — works because `.wb` is plain text

### AI that actually knows your notebook

Wolfbook exposes your live kernel and notebook contents to AI agents via a set of purpose-built optimised tools. GitHub Copilot in Agent mode can, for  example:

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

Wolfbook can be found in the VS Code Marketplace or on GitHub in the [Releases](https://github.com/vanbaalon/wolfbook/releases) section. Or on Antigravity's marketplace or https://open-vsx.org/.

**3. Create your first notebook**

Create an empty file `test.wb` and open it in VS Code. The kernel starts automatically on first cell execution.

**4. Enable AI (optional but recommended)**

Install GitHub Copilot from the Extensions panel (free tier available; GitHub Education gives generous limits). Open the Copilot Chat panel (`⌃⌘I`), switch to **Agent** mode, and start asking. From our experience Claude Code in Agent mode gives the best result.

→ Full setup guide: [Getting Started](docs/getting-started.md)

---

## Architecture

Wolfbook is built around two bespoke native C++ addons:

**`mathematica-wstp-node`** — connects directly to the Wolfram kernel via the WSTP (Wolfram Symbolic Transfer Protocol) protocol. No subprocess piping, no ZeroMQ. This is what makes mid-evaluation abort, Dynamic widgets, and Dialog[] subsessions possible.

**`wolfbook-btl`** (Box-to-LaTeX) — translates Wolfram's internal `TraditionalForm` box structures to LaTeX, rendered client-side with KaTeX. About 10× faster than Wolfram's built-in `TeXForm` for complex expressions, and handles many cases TeXForm cannot and also dynamically adjusts the page width and breaks the line at appropriate positions to make it fit the page width. Long expressions are also paginated or can be exported in one click in .wl (Wolfram Language) format.

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
| [Best Practices](docs/best-practices.md) | How to work effectively with the agent |
| [Building from Source](docs/building.md) | Compile the native addons, package the extension |

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

Wolfbook was heavily inspired by and initially based on the official vscode-wolfram extension by Wolfram Research Inc. (Apache 2.0). The LSP client layer and kernel-finding logic originate from that project. The notebook frontend and the entire kernel backend have since been rewritten from scratch.

