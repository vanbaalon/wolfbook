# MCP & Agent Tools — Using Wolfbook with Claude Code, Codex, and Other Agents

→ [Back to README](../README.md) · [Using Cline (any model — DeepSeek, Claude, GPT-4o…)](using_cline.md)

> **Also new:** Wolfbook now ships an experimental in-extension research agent — see [Oberon](oberon-agent.md).


Wolfbook exposes its kernel and notebook tools as an **MCP (Model Context Protocol) server**. This means any MCP-compatible AI agent can read your notebook, evaluate expressions, and manipulate cells — not just GitHub Copilot.

---

## What is MCP?

MCP (Model Context Protocol) is an open standard for connecting AI agents to external tools and data sources. An MCP server exposes a set of named tools; any MCP client (Claude Code, OpenAI Codex, Cursor, and others) can discover and call those tools.

Wolfbook acts as an MCP server, exposing the same tools that GitHub Copilot uses in Agent mode. This means:

- **Claude Code** (Anthropic's terminal agent) can evaluate Wolfram Language, read your notebook, and insert cells
- **OpenAI Codex** and other compatible agents can do the same
- Any future MCP-compatible tool will work automatically
- Antigravity's agent tool can also be connected using MCP server 
---

## Available MCP Tools

### Notebook tools (also used by GitHub Copilot)

| Tool | What it does |
|---|---|
| `wolfbookContext` | Read all cells and their outputs |
| `wolfbookEval` | Evaluate any Wolfram Language expression in the live kernel |
| `wolfbookLookup` | Look up usage, options, and documentation link for any symbol |
| `wolfbookWebHelp` | Fetch the full Wolfram reference page for a built-in symbol |
| `wolfbookInsert` | Insert a new code or Markdown cell at any position |
| `wolfbookEdit` | Replace the source of an existing cell; optionally re-evaluate immediately |
| `wolfbookRun` | Execute an existing cell and store the result as its output |
| `wolfbookDelete` | Remove a cell (source saved to recovery file before deletion) |
| `wolfbookState` | List all user-defined symbols and their current values |
| `wolfbookSaveNotebook` | Save the active notebook to disk |
| `wolfbookRestart` | Restart the kernel |
| `wolfbookAbort` | Interrupt the currently running evaluation |
| `wolfbookDebug` | Full control of the step-through debugger |

### Presentation tools (`.wslide` format)

| Tool | What it does |
|---|---|
| `wolfslide_editSlide` | Edit the content of an existing slide |
| `wolfslide_block` | Add or modify a content block on a slide |
| `wolfslide_bulkInsert` | Insert multiple blocks at once |
| `wolfslide_deleteSlide` | Remove a slide |
| `wolfslide_insertSlide` | Insert a new slide |
| `wolfslide_getContext` | Read the full presentation context |
| `wolfslide_listSlides` | List all slides with titles |
| `wolfslide_getSlide` | Read a specific slide's content |
| `wolfslide_advanced` | Advanced slide operations |
| `wolfslide_imageAsset` | Manage image assets in the presentation |
| `wolfslide_setTheme` | Change the presentation theme |
| `wolfslide_exportHtml` | Export the presentation to standalone HTML |

---

## Using with Claude Code

[Claude Code](https://docs.anthropic.com/en/docs/agents/claude-code) is Anthropic's terminal-based coding agent. With Wolfbook's MCP server running, Claude Code can:

- Read your `.wb` notebook and understand its current state
- Evaluate Wolfram Language expressions to verify intermediate results
- Insert and edit cells to implement calculations you describe
- Look up Wolfram documentation without a browser
- Drive the debugger to diagnose problems

### Setup

Wolfbook provides a one-click setup command that writes the correct configuration automatically.

1. Ensure Wolfbook is installed and a `.wb` notebook is open in VS Code with the kernel running
2. Open the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`) and run **"Wolfbook: Configure Claude and Codex Agents"**
3. Wolfbook writes a user-scoped Claude Code connection, configures Claude Desktop and Codex, and installs the personal `wolfbook` skills
4. Restart the agent if `/wolfbook` (Claude Code) or `$wolfbook` (Codex) does not appear immediately

The user-scoped connection works regardless of which nested repository Claude Code starts in. The stdio bridge connects it to the running Wolfbook server, which routes among all participating VS Code windows and notebooks. Claude Desktop receives the same routing guidance from the MCP handshake even though it has no local skill directory.

> **MCP toggle**: If you want to disable external agent connections entirely, set `wolfbook.mcpEnabled: false` in your settings and reload the window.

### Economy mode for smaller models

Wolfbook also exposes a compact, per-connection MCP surface. It keeps the basic
`wolfbook_*` notebook and kernel workflow (open/read/search/edit/insert/delete,
run/evaluate, inspect outputs and symbols, validate, save, status, long results,
and kernel control) while omitting slides, papers, Fairy/Gold/team tools,
debugging, terminal/file utilities, package search, LaTeX, and deprecated names.
The normal MCP endpoint is unchanged, so full and economy clients can connect at
the same time without changing a VS Code setting or reloading the window.

For an HTTP/SSE client, register the economy endpoint under a distinct name:

```json
{
  "mcpServers": {
    "wolfbook-economy": {
      "url": "http://127.0.0.1:27182/sse/economy"
    }
  }
}
```

For a stdio client such as Codex or Claude Code, use the same bridge path as the
normal Wolfbook entry and add `--profile=economy`:

```json
{
  "mcpServers": {
    "wolfbook-economy": {
      "command": "/path/to/node",
      "args": ["/path/to/stdio-bridge.js", "--profile=economy"]
    }
  }
}
```

Use either the full entry or the economy entry in a small-model client, rather
than enabling both there. The Control Room Health tab shows both live endpoint
forms and labels each connected session with its active tool profile.

### Compact response and notebook contract

MCP responses include a short text summary plus canonical `structuredContent`
with `ok`, `state`, `code`, `target`, `notebookRevision`, `operation`,
`result`, `warnings`, and `nextAction` where applicable. Large responses are
bounded by default and return a `result_handle`; retrieve only the needed slice
with `wolfbook_getResult`.

Notebook tools accept an explicit `notebook` path or filename. An explicit
notebook outranks the sticky session target and does not change it. If the same
basename is open in more than one window, pass an absolute path or `client_id`.

For efficient repeated work:

- pass `if_revision` to `wolfbook_getNotebookContext` to avoid retransferring an
  unchanged notebook;
- pass `since_revision` for a changed-cell delta;
- use `cell_ids` or `cell_numbers` for a selective canonical read;
- pass several anchors as `queries` to `wolfbook_searchCells`;
- pass `expected_notebook_revision` to insert, edit, and delete operations to
  reject stale mutations.

Edit-and-evaluate responses report the committed notebook edit separately from
the evaluation state. Slow operations return a handle after a short fast path;
use `wolfbook_waitEvaluation` for terminal or meaningful-progress updates.

### Example Claude Code session

```bash
$ claude

> I have a Wolfbook notebook with a QSC calculation. Can you read it and 
  verify that the numerical output in cell 5 is consistent with the 
  expected strong-coupling limit?

Claude reads the notebook via wolfbookContext, evaluates a verification 
expression via wolfbookEval, and reports back.
```

---

## Using with Codex

Wolfbook configures `[mcp_servers.wolfbook]` in `~/.codex/config.toml` and installs the shared skill at `~/.agents/skills/wolfbook/`. Codex can select it automatically for Mathematica/Wolfram Language work, or you can invoke it explicitly with `$wolfbook`.

Run **"Wolfbook: Configure Claude and Codex Agents"** to repair either entry after a manual configuration change. Extension upgrades repair the versioned bridge path automatically.

---

## Using with Antigravity

[Antigravity](https://antigravity.ai) is an AI-native fork of VS Code. Wolfbook integrates with its agent tool system directly.

### Setup

1. Open the Command Palette and run **"Wolfbook: Configure Antigravity MCP"**
2. Wolfbook writes both an MCP config entry and installs a dedicated skill at `~/.gemini/antigravity/skills/wolfbook/`
3. Restart Antigravity — the Wolfbook tools appear in its agent tool panel automatically

---

GitHub Copilot in Agent mode uses the same MCP tools. See [AI Integration](ai-integration.md) for the full Copilot-specific guide.

The key difference: Copilot is accessed via the VS Code chat panel (`⌃⌘I`), while Claude Code and Codex are accessed via the terminal or their own interfaces. Every MCP client also receives a server-level instruction telling it to prefer Wolfbook over launching a separate `wolframscript` or `WolframKernel` process for ordinary VS Code work.

---

## Tool Safety

All tools are designed to be safe to call at any time:

- **Kernel busy detection** — evaluation tools refuse to dispatch if the kernel is already busy, returning a clear error message instead of corrupting the WSTP link
- **Recovery files** — `wolfbookDelete` saves the deleted cell source to `ai_deleted_cells.md` before removing it; `wolfbookEval` logs all expressions to `ai_eval_log.md`
- **Confirmation on destructive actions** — `wolfbookRestart` shows a confirmation dialog before clearing the kernel state

---

## For Extension Developers

Wolfbook's MCP server is built into the VS Code extension. If you are building a tool or extension that wants to interact with a live Wolfram kernel, you can:

- Connect to the Wolfbook MCP server as a client
- Use the `wolfbookEval` tool to evaluate expressions and get results back
- Use `wolfbookContext` to read the current notebook state

The MCP server follows the standard MCP specification. See the [MCP documentation](https://modelcontextprotocol.io) for client integration details.
