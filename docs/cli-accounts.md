# Workspace CLI accounts and models

Click the **account icon** on the right of the bottom status bar to open the configurator. You can also click **Claude Code** or **Codex CLI** under the main workspace folder in **Wolfbook Controls → CLI Accounts**, or run **Wolfbook: Manage CLI Accounts** from the Command Palette.

1. Choose **Add account profile**, give it a name (for example, Personal or Work), and complete the CLI's browser sign-in in the terminal that opens.
2. Choose **Check selected account** to verify which account the CLI is using. Profile names are labels you supply, not verified account identities.
3. Choose **Open CLI**, or use the terminal icon beside the account row.
4. Use **Switch account for this workspace folder** to select another saved profile or return to **Default account**.

Profiles can be reused across workspaces. Each window's **main workspace folder** remembers its own account and model choices separately for Claude and Codex. This means the first folder listed in the current VS Code workspace, even when it contains several Git repositories. Nested Git roots and the active editor do not change the selection. Opening the same main folder again restores its choices; multi-root workspaces use their first folder. Selections persist locally across VS Code restarts. They are not written into the workspace or Settings Sync.

Use **Default model for this workspace folder** and **Default subagent model for this workspace folder** in the configurator. Enter a model ID supported by your account; Claude also accepts aliases such as `opus`, `sonnet`, and `haiku`. Clear a field to return to the CLI's defaults. Model settings belong to the workspace folder, independently of the selected account, and are shown in the sidebar row's tooltip.

For new Wolfbook CLI launches, the main model is passed through `--model`. Claude's subagent default uses `CLAUDE_CODE_SUBAGENT_MODEL`; Codex's uses `agents.default_subagent_model`. Current CLI versions support these settings. Explicit per-agent or spawn settings can override the subagent default (older Claude versions applied its variable as a stronger override). Wolfbook does not force a model onto every subagent. Login and account-status commands are unaffected.

Switching affects **new CLI sessions launched through Wolfbook**. Existing sessions keep their account. This does not change the account in the standalone Claude Code or Codex VS Code extension, desktop app, or terminals opened elsewhere. Default uses the CLI's usual environment and login, including any inherited custom configuration directory.

Named profiles use separate configuration directories beneath Wolfbook's VS Code global storage (`agent-accounts/<provider>/<profile-id>`). Claude uses `CLAUDE_CONFIG_DIR`, which also selects a separate macOS Keychain entry on current Claude Code versions. Codex uses `CODEX_HOME` and file credential storage. Wolfbook stores only profile labels, IDs, workspace selections, and model defaults; the CLIs manage login and token refresh. Account directories are outside repositories. In remote VS Code windows they live on the extension host, where the CLI must also be installed.

New profiles start with fresh user settings, history, plugins, and MCP configuration. Your default user configuration and credentials are not copied. Configure any desired user-level integrations in each profile; project-level configuration still applies. Named-profile launches remove inherited API-key, OAuth-token, and common alternate-provider overrides so those environment variables do not silently choose another account. Project or managed settings can still affect authentication; use **Check selected account** before working with a newly configured profile.

**Rename selected profile** changes its label everywhere. **Forget selected profile** removes it from the manager for all workspace folders and returns those selections to Default; it retains CLI data and credentials on disk. It does not sign out or delete account data.

Install the current Claude Code or Codex CLI first. If automatic executable discovery fails, set **wolfbook.agentAccounts.claudeExecutable** or **wolfbook.agentAccounts.codexExecutable** to the absolute executable path, without arguments. CLI launch requires a trusted workspace. Login and status run directly as terminal processes; after they finish, use **Open CLI** for an interactive session.

References: [Claude credential isolation](https://code.claude.com/docs/en/authentication#credential-management), [Codex credential storage](https://developers.openai.com/codex/auth), [Codex configuration locations](https://developers.openai.com/codex/config-advanced).

Model references: [Claude main models](https://code.claude.com/docs/en/model-config), [Claude subagent defaults](https://code.claude.com/docs/en/sub-agents), [Codex main and subagent configuration](https://developers.openai.com/codex/config-reference).
