# Using Wolfbook with Cline

→ [Back to README](../README.md) · [MCP & Agent Tools](mcp-and-agent-tools.md)

**Cline** is a VS Code extension that brings a full AI coding agent directly into your editor — and, unlike GitHub Copilot, it lets you plug in **any AI model**: DeepSeek, Claude (via API key), GPT-4o, Gemini, local Ollama models, and many others. Combined with Wolfbook's MCP server, Cline can read your notebook, evaluate Wolfram Language expressions, insert and edit cells, and drive the debugger — all inside VS Code, using whichever model you prefer.

---

## 1. Install Cline

1. Open the VS Code Extensions panel (`⇧⌘X` / `Ctrl+Shift+X`)
2. Search for **Cline**
3. Install the extension by **saoudrizwan**
4. A Cline icon will appear in the Activity Bar on the left

> Cline is open source: [github.com/cline/cline](https://github.com/cline/cline)

---

## 2. Add an AI model

When you first open Cline it will ask you to choose a provider. You can change this at any time via the gear icon in the Cline panel.

### DeepSeek (recommended — very cheap, strong reasoning)

1. Get a key at [platform.deepseek.com](https://platform.deepseek.com)
2. In Cline settings, set **Provider** → **DeepSeek**
3. Paste your API key
4. Choose a model:
   - `deepseek-chat` — fast general-purpose model
   - `deepseek-reasoner` — chain-of-thought model, better for maths and logic

### Claude (Anthropic)

1. Get a key at [console.anthropic.com](https://console.anthropic.com)
2. **Provider** → **Anthropic**
3. Paste your API key
4. Recommended model: `claude-sonnet-4-5` or the latest Sonnet

### OpenAI (GPT-4o, o1, o3)

1. Get a key at [platform.openai.com](https://platform.openai.com)
2. **Provider** → **OpenAI**
3. Paste your API key

### Local models via Ollama

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull llama3`
2. **Provider** → **Ollama**
3. Enter the model name; Cline connects to `http://localhost:11434` automatically

### Any OpenAI-compatible endpoint

Use **Provider** → **OpenAI Compatible**, then supply the base URL and API key. This works with Together AI, Groq, Mistral, and others.

---

## 3. Connect Wolfbook tools via MCP

Wolfbook runs an **MCP server** inside VS Code on port 27182. Cline connects to it via a lightweight stdio bridge that ships with the extension — this avoids timing issues that arise if Cline tries to connect before the server is ready.

### Step 1 — Find the bridge path

The bridge script lives inside the installed Wolfbook extension. Run this in a terminal to find the current path:

```bash
echo ~/.vscode/extensions/$(ls ~/.vscode/extensions | grep "wolfbook.wolfbook-" | sort -V | tail -1)/out/extension/claude-mcp/stdio-bridge.js
```

Copy the output — you will use it in the next step.

### Step 2 — Find your Node.js binary

The bridge runs with Node.js. If `node` is in your PATH this is simply `node`. To check:

```bash
which node
```

If that returns a path (e.g. `/opt/anaconda3/bin/node` or `/usr/local/bin/node`), use that full path in the config below for reliability. If `node` is reliably on your PATH you can use just `node`.

### Step 3 — Edit the Cline MCP settings file

Open Cline's MCP settings file. The easiest way:

- In the Cline panel, click the **MCP Servers** icon (plug icon at the top), then **Edit MCP Settings**

Or open it directly:

| Platform | Path |
|---|---|
| macOS / Linux | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |

Replace the file contents with:

```json
{
  "mcpServers": {
    "wolfbook": {
      "command": "/path/to/node",
      "args": ["/path/to/stdio-bridge.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Substitute the actual paths from Steps 1 and 2. Example on macOS:

```json
{
  "mcpServers": {
    "wolfbook": {
      "command": "/opt/anaconda3/bin/node",
      "args": ["/Users/yourname/.vscode/extensions/wolfbook.wolfbook-2.6.51/out/extension/claude-mcp/stdio-bridge.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Step 4 — Reload and verify

1. Reload the VS Code window (`⌘⇧P` → **Reload Window**)
2. Open the Cline panel and click the **MCP Servers** icon
3. You should see **wolfbook** listed as a connected server with all tools visible

> **Note:** Wolfbook's MCP server starts a few seconds after VS Code loads. The stdio bridge waits automatically — no manual retry needed.

---

## 4. Start using Wolfbook tools in Cline

Open a `.wb` notebook, start the kernel (click **Start Kernel** in the notebook toolbar), then open the Cline chat. Cline can now:

- Read your notebook and all cell outputs
- Evaluate any Wolfram Language expression
- Insert, edit, and run cells
- Look up symbol documentation
- Control the step-through debugger

**Example prompts:**

```
Read my notebook and explain what the calculation is doing.
```

```
Evaluate Series[Exp[x], {x, 0, 8}] and insert the result as a new cell.
```

```
Find the bug in cell 3 — the output looks wrong.
```

```
Rewrite the loop in cell 5 to use Table instead of Do, then evaluate it.
```

---

## 5. Updating Wolfbook

When a new version of the Wolfbook extension is installed, the bridge path changes (the version number in the folder name increments). Update the path in `cline_mcp_settings.json` by re-running the command from Step 1 and replacing the `args` value.

> Future versions of Wolfbook may add a **Configure Cline MCP** command to do this automatically.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Wolfbook tools not visible in Cline | Check that VS Code is fully loaded and the `.wb` notebook is open. The MCP server starts only when the extension activates. |
| `node: command not found` error | Use the full path to node from `which node` in the `command` field |
| Bridge path error after Wolfbook update | Re-run the Step 1 command and update the path in `cline_mcp_settings.json` |
| Cline asks for tool approval on every call | Set `"autoApprove": ["wolfbook*"]` to approve all Wolfbook tools automatically |
| Port 27182 already in use | Wolfbook tries ports 27182–27202 in sequence; the bridge discovers the active port automatically |
