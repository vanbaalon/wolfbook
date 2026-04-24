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

### Automatic setup (recommended)

Wolfbook configures Cline automatically when VS Code starts, **if Cline is already installed**. After installing both extensions:

1. Reload the VS Code window (`⌘⇧P` → **Reload Window**)
2. Open the Cline panel → **MCP Servers** icon — you should see **wolfbook** listed

That's it. No manual file editing needed.

If the automatic setup didn't run (e.g. you installed Cline after Wolfbook), run the command manually:

`⌘⇧P` → **Wolfbook: Configure Cline MCP**

This writes the correct paths automatically and offers to reload the window.

### Manual setup (if needed)

If you prefer to configure it yourself, or need to debug the settings:

**Step 1** — Find the bridge path:

```bash
echo ~/.vscode/extensions/$(ls ~/.vscode/extensions | grep "wolfbook.wolfbook-" | sort -V | tail -1)/out/extension/claude-mcp/stdio-bridge.js
```

**Step 2** — Find your Node.js binary:

```bash
which node
```

**Step 3** — Open Cline's MCP settings file:
- In the Cline panel, click the **MCP Servers** icon → **Edit MCP Settings**
- Or open it directly:
  - macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
  - Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

Set the contents to:

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

Substituting the paths from Steps 1 and 2.

### Verify

1. Reload the VS Code window
2. Open the Cline panel → **MCP Servers** icon
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

When a new version of Wolfbook is installed, the bridge path changes (the version number in the folder name updates). Wolfbook re-configures Cline automatically on the next VS Code reload — no manual action needed.

You can also trigger it manually at any time: `⌘⇧P` → **Wolfbook: Configure Cline MCP**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Wolfbook tools not visible in Cline | Check that VS Code is fully loaded and the `.wb` notebook is open. The MCP server starts only when the extension activates. |
| `node: command not found` error | Use the full path to node from `which node` in the `command` field |
| Bridge path error after Wolfbook update | Re-run the Step 1 command and update the path in `cline_mcp_settings.json` |
| Cline asks for tool approval on every call | Set `"autoApprove": ["wolfbook*"]` to approve all Wolfbook tools automatically |
| Port 27182 already in use | Wolfbook tries ports 27182–27202 in sequence; the bridge discovers the active port automatically |
