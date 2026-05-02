# Adding DeepSeek Models to VS Code Copilot

Instructions to add DeepSeek models (or any OpenAI-compatible provider) to VS Code's GitHub Copilot model selector.

## Prerequisites

- A DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com)
- VS Code with GitHub Copilot extension installed

## Steps

### 1. Install the bridge extension

Install **"OAI Compatible Provider for Copilot"** from the VS Code marketplace.

### 2. Configure models in `settings.json`

Open the command palette (`Cmd+Shift+P`) and run:

```
Preferences: Open User Settings (JSON)
```

Add the following entries **inside the top-level `{}`** of your `settings.json`:

```jsonc
"oaicopilot.baseUrl": "https://api.deepseek.com/v1",
"oaicopilot.models": [
  {
    "id": "deepseek-chat",
    "owned_by": "deepseek",
    "context_length": 1000000,
    "max_tokens": 16000
  },
  {
    "id": "deepseek-reasoner",
    "owned_by": "deepseek",
    "context_length": 1000000,
    "max_tokens": 16000,
    "enable_thinking": false
  },
  {
    "id": "deepseek-v4-pro",
    "owned_by": "deepseek",
    "context_length": 1000000,
    "max_tokens": 16000,
    "enable_thinking": false
  },
  {
    "id": "deepseek-v4-flash",
    "owned_by": "deepseek",
    "context_length": 1000000,
    "max_tokens": 16000,
    "enable_thinking": false
  }
]
```

> **Note:** `enable_thinking: false` disables the thinking/chain-of-thought output for reasoning models. Omit or set to `true` if you want to see the reasoning trace.

### 3. Provide the API key

Click the **spinner / model selector** in the Copilot chat input bar → **Add model** → **OAI Compatible** → enter your DeepSeek API key.

### 4. Activate models

The DeepSeek models will appear in the model selector list, greyed out. **Double-click** each one to activate it.

## Usage

Once activated, you can switch between models from the Copilot chat toolbar. Your API key is stored securely in VS Code's secret storage.
