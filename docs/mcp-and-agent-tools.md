# MCP & Agent Tools — Using Wolfbook with Claude Code, Codex, and Other Agents

→ [Back to README](../README.md) · [Using Cline (any model — DeepSeek, Claude, GPT-4o…)](using_cline.md)

> **Also new:** Wolfbook now ships an experimental in-extension research agent — see [Oberon](oberon-agent.md).


Wolfbook exposes its kernel and notebook tools as an **MCP (Model Context Protocol) server**. This means any MCP-compatible AI agent — Claude Code, Codex, Claude Science and others — can read your notebook, evaluate expressions, and manipulate cells.

---

## What is MCP?

MCP (Model Context Protocol) is an open standard for connecting AI agents to external tools and data sources. An MCP server exposes a set of named tools; any MCP client (Claude Code, OpenAI Codex, Cursor, and others) can discover and call those tools.

Wolfbook acts as an MCP server. This means:

- **Claude Code** (Anthropic's terminal agent) can evaluate Wolfram Language, read your notebook, and insert cells
- **OpenAI Codex** and other compatible agents can do the same
- Any future MCP-compatible tool will work automatically
- Antigravity's agent tool can also be connected using MCP server 
---

## Available MCP Tools

### Notebook tools

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

## Using with Claude Science

Claude Science is Anthropic's local app for research work. It runs as a background service and opens in your browser. Wolfbook connects to it as a **Local command** connector.

Claude Science runs every connector inside a macOS sandbox. The sandbox cannot read files in your home folder, and it cannot open network connections to other programs on your Mac. Wolfbook works within those rules:

- the connector talks to Wolfbook through a **private socket**, `/private/tmp/wolfbook-mcp-<your uid>/mcp.sock`, which only your user account can use;
- the bridge program is copied to `~/.wolfbook/mcp/stdio-bridge.js`, a fixed location, so Wolfbook updates don't break the connector;
- two entries in `~/.claude-science/config.toml` let the sandbox read the bridge (and Node.js, if it is installed in your home folder) and connect to the socket. Nothing else in the sandbox changes.

### Setup

1. With VS Code and Wolfbook running, run **"Wolfbook: Configure Claude Science MCP"** from the Command Palette. When Claude Science is installed, Wolfbook also offers this itself.
2. Wolfbook lists exactly what it will allow in the sandbox and asks you to confirm.
3. Click **Restart Claude Science** when prompted, or quit and reopen it yourself. The sandbox settings apply only after a restart.
4. Start a **new conversation** in Claude Science.

Wolfbook never changes Claude Science's sandbox without asking. When VS Code starts, Wolfbook only keeps a connector it already set up current. Do **not** turn off Claude Science's sandbox to get Wolfbook working.

### Manual setup

1. Find your user id: run `id -u` in Terminal (for example `501`).
2. Copy the bridge somewhere fixed:

   ```bash
   mkdir -p ~/.wolfbook/mcp
   cp ~/.vscode/extensions/wolfbook.wolfbook-*/out/extension/claude-mcp/stdio-bridge.js ~/.wolfbook/mcp/
   ```
3. Add these lines to `~/.claude-science/config.toml` (create the file if it does not exist). If the file already has a `[sandbox]` or `[sandbox.network]` section, add the line to that section instead. Replace `<you>` and `501`:

   ```toml
   [sandbox]
   user_read_paths = ["/Users/<you>/.wolfbook/mcp"]

   [sandbox.network]
   allow_unix_sockets = ["/private/tmp/wolfbook-mcp-501"]
   ```

   If `which node` prints a path inside your home folder (for example `~/.local/node/bin/node`), also add that installation's folder, `/Users/<you>/.local/node`, to `user_read_paths`. Node.js from Homebrew or the nodejs.org installer needs nothing extra.
4. Quit and reopen Claude Science.
5. In Claude Science open **Customize → Connectors → Add connector → Local command** and enter:
   - **Name:** `wolfbook`
   - **Command:** `/opt/homebrew/bin/node /Users/<you>/.wolfbook/mcp/stdio-bridge.js --socket=/private/tmp/wolfbook-mcp-501/mcp.sock` (use your own Node path from `which node`)
6. Start a new conversation.

Notes:

- **Keep VS Code running.** The socket exists only while a VS Code window runs Wolfbook. Without one, the connector reports that it could not connect.
- **Use *Local command*, not *Remote*.** Claude Science accepts only public `https` addresses for remote connectors.
- If the connector fails with `sandbox-exec: execvp() … Operation not permitted`, the sandbox cannot read Node.js or the bridge. Check `user_read_paths`, then restart Claude Science.
- If your organisation has turned off custom connectors, the **Add connector** button is missing and neither method works.

---

Every MCP client also receives a server-level instruction telling it to prefer Wolfbook over launching a separate `wolframscript` or `WolframKernel` process for ordinary VS Code work.

---

## Protocol and transports

Wolfbook speaks MCP protocol versions **2025-11-25**, 2025-06-18, 2025-03-26 and 2024-11-05, and answers each client in the version that client asks for. Clients on 2025-03-26 or later also receive **tool annotations**, which mark each tool as read-only, destructive, or reaching outside your machine. Clients can use these to skip confirmation prompts for tools that only read.

| Endpoint | Transport |
|---|---|
| `http://127.0.0.1:27182/mcp` (`/mcp/economy`) | Streamable HTTP, the current standard |
| `http://127.0.0.1:27182/sse` (`/sse/economy`) | legacy HTTP+SSE, kept for older clients |
| `/private/tmp/wolfbook-mcp-<uid>/mcp.sock` | both of the above, over a private Unix socket (macOS/Linux) for sandboxed hosts |

**Access.** Any program on your Mac can reach `127.0.0.1`. That includes other user accounts and sandboxed apps that may use the network but not your files. So Wolfbook asks TCP callers for a per-user token, stored in `~/.wolfbook/mcp-token` and readable only by you. The stdio bridge, other Wolfbook windows and the Overleaf extension's local server read it automatically, so you don't need to configure anything. The private socket needs no token. Web pages are refused separately, by their `Origin` and `Host` headers. The first time a new AI agent connects, Wolfbook shows a notice with a **Block** button. It never makes the agent wait. **Wolfbook: Manage Agent Access** allows or blocks agents later. If a client connects by URL and can't send an `Authorization` header, turn off `wolfbook.mcp.requireToken`.

Most clients should keep using the stdio bridge that the configure commands install. It waits for VS Code to start and finds the right port or socket by itself. The port moves within 27182–27202 when that range is busy.

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
