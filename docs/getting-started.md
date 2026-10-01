# Getting Started with Wolfbook

→ [Back to README](../README.md)

---

## Setup Checklist

### 1. Install VS Code

Download from [code.visualstudio.com](https://code.visualstudio.com). Version 1.95 or later required.

### 2. Install the Wolfram kernel

You need one of:

- **Wolfram Engine** (free for non-commercial use): [wolfram.com/engine](https://wolfram.com/engine)
- **Mathematica** (if you already have a licence)

> ⚠️ **Activate before you start.** Wolfram Engine requires a one-time free activation at [wolfram.com/engine/free-license](https://wolfram.com/engine/free-license). This needs an internet connection. Do it before your first session.

### 3. Install the Wolfbook extension

Type wolfbook in the Extensions panel and install it.
Enable updates as we will be pushing updates on regular basis.
To open the Extension panel press `Ctrl+Shift+X` or `Cmd+Shift+X`.

### 4. Install Node.js (for AI agents)

Wolfbook connects AI agents through a small Node.js program. Install the **LTS** version from [nodejs.org](https://nodejs.org) (or `brew install node` on macOS, `winget install OpenJS.NodeJS.LTS` on Windows), then quit and reopen VS Code.

### 5. Install an AI agent (optional, highly recommended)

Install **Claude Code for VS Code** (publisher Anthropic) or **Codex – OpenAI's coding agent** (publisher OpenAI) from the Extensions panel and sign in. Wolfbook registers itself with both automatically when it starts. If an agent does not see the Wolfbook tools, run **Wolfbook: Configure Claude and Codex Agents** from the Command Palette and start a new conversation. Step-by-step instructions: [AI agents: Claude Code and Codex](../README.md#ai-agents-claude-code-and-codex).

### 6. Install TeX (only for WPaper)

To see the live compiled page of a `.tex` paper, install a TeX distribution with `latexmk`: [MacTeX](https://tug.org/mactex/) on macOS, [MiKTeX](https://miktex.org) or [TeX Live](https://tug.org/texlive/) on Windows ([details](wpaper-windows-setup.md)), TeX Live on Linux. Notebooks do not need TeX.

> An illustrated version of this guide, with a short tutorial and example prompts, is in the [Wolfbook Quick Start (PDF)](Wolfbook-Quick-Start.pdf).

## Your First Notebook

Create an empty file called `test.wb` anywhere in your workspace and open it. You will see an empty notebook interface.

**Add your first cell:** hover between the placeholder areas and click **+ Code**, or press `B` in command mode (when no cell is being edited) to insert a cell below.

**Evaluate a cell:** press `Shift+Enter`. The kernel starts automatically on first use. You should see output rendered below the cell.

Try these to verify everything is working:

```wolfram
Integrate[Sin[x]^2, {x, 0, Pi}]
```

Expected output: `π/2`, rendered as typeset LaTeX.

```wolfram
Plot[Sin[x], {x, 0, 10 Pi}, PlotStyle -> Thick]
```

Expected output: an inline SVG plot.

---

## Essential Keyboard Shortcuts

| Action | Mac | Windows/Linux |
|---|---|---|
| Evaluate cell, advance | `Shift+Return` | `Shift+Enter` |
| Abort evaluation | `Cmd+.` | `Ctrl+.` |
| Restart kernel | `Cmd+Shift+R` | `Ctrl+Shift+R` |
| Insert cell below | exit cell, then `B` | same |
| Insert cell above | exit cell, then `A` | same |
| Switch cell to Markdown | exit cell, then `M` | same |
| Switch cell to code | exit cell, then `Y` | same |
| Delete cell | exit cell, then `D D` | same |
| Move cell up / down | `Opt+↑` / `Opt+↓` | `Alt+↑` / `Alt+↓` |
| Format (WL formatter) | `Opt+Shift+F` | `Alt+Shift+F` |
| Evaluate selection | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Add selection to Watch | `Cmd+Shift+W` | `Ctrl+Shift+W` |
| Split editor | `Cmd+\` | `Ctrl+\` |
| Start debug session | `Cmd+Shift+D` | `Ctrl+Shift+D` |
| Step over | `F10` | `F10` |
| Step into | `F11` | `F11` |
| Set / clear breakpoint | click gutter or `F9` | `F9` |

---

## Editing Mode vs. Command Mode

**This is the most important difference from standard Mathematica.** VS Code notebooks have two modes:

- **Editing mode** — keystrokes enter text into the cell
- **Command mode** — keystrokes act on cells (insert, delete, move, switch type)

To leave editing mode in Wolfbook: press `↓` past the last line of the cell, or `↑` past the first line. (Wolfbook redefines `Esc` for symbol input, so it does not enter command mode the way Jupyter shortcuts expect.)

Once in command mode you can press `B` (new cell below), `A` (above), `D D` (delete), `M` (Markdown), `Y` (code), `Opt+↑/↓` (move).

---

## Symbol Input

Wolfbook gives you three ways to enter Greek letters and special symbols:

1. **Type the full named form:** `\[Alpha]` auto-replaces to `α` as you type
2. **Escape alias:** press `Esc`, type `a`, press `Esc` again → `α`
3. **Format the whole cell:** `Alt+Shift+F` converts all `\[Name]` forms to Unicode at once

---

## Checking Your Kernel Connection

The notebook toolbar shows the kernel status. If the kernel is offline, click the restart button or press `Cmd+Shift+R`.

To confirm the kernel is alive after an abort:

```wolfram
2 + 2
```

Should return `4` immediately.

If the kernel was not detected you can click on the settings on the bar on top of the notebook and select the kernel path. You can also set backgroud colour there.

---

## Next Steps

- [Features](features.md) — debugger, Dynamic widgets, Watch panel, output formats
- [Best Practices](best-practices.md) — how to structure your work for reliable results
- [MCP & Agent Tools](mcp-and-agent-tools.md) — using Wolfbook with Claude Code, Codex and other agents
