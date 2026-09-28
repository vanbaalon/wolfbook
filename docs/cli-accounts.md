# Repository CLI accounts

Click the **account icon** on the right of the bottom status bar to open the configurator. You can also click **Claude Code** or **Codex CLI** under a repository in **Wolfbook Controls → CLI Accounts**, or run **Wolfbook: Manage CLI Accounts** from the Command Palette.

1. Choose **Add account profile**, give it a name (for example, Personal or Work), and complete the CLI's browser sign-in in the terminal that opens.
2. Choose **Check selected account** to verify which account the CLI is using. Profile names are labels you supply, not verified account identities.
3. Choose **Open CLI**, or use the terminal icon beside the account row.
4. Use **Switch account for this repository** to select another saved profile or return to **Default account**.

Profiles can be reused across repositories. Each repository remembers its own choice separately for Claude and Codex. The view uses repositories discovered by VS Code Git, including repositories inside a parent workspace; folders without a discovered repository are supported too. Selections persist locally across VS Code restarts. They are not written into the repository or Settings Sync.

Switching affects **new CLI sessions launched through Wolfbook**. Existing sessions keep their account. This does not change the account in the standalone Claude Code or Codex VS Code extension, desktop app, or terminals opened elsewhere. Default uses the CLI's usual environment and login, including any inherited custom configuration directory.

Named profiles use separate configuration directories beneath Wolfbook's VS Code global storage (`agent-accounts/<provider>/<profile-id>`). Claude uses `CLAUDE_CONFIG_DIR`, which also selects a separate macOS Keychain entry on current Claude Code versions. Codex uses `CODEX_HOME` and file credential storage. Wolfbook stores only profile labels, IDs, and repository selections; the CLIs manage login and token refresh. Account directories are outside repositories. In remote VS Code windows they live on the extension host, where the CLI must also be installed.

New profiles start with fresh user settings, history, plugins, and MCP configuration. Your default user configuration and credentials are not copied. Configure any desired user-level integrations in each profile; project-level configuration still applies. Named-profile launches remove inherited API-key, OAuth-token, and common alternate-provider overrides so those environment variables do not silently choose another account. Project or managed settings can still affect authentication; use **Check selected account** before working with a newly configured profile.

**Rename selected profile** changes its label everywhere. **Forget selected profile** removes it from the manager for all repositories and returns those selections to Default; it retains CLI data and credentials on disk. It does not sign out or delete account data.

Install the current Claude Code or Codex CLI first. If automatic executable discovery fails, set **wolfbook.agentAccounts.claudeExecutable** or **wolfbook.agentAccounts.codexExecutable** to the absolute executable path, without arguments. CLI launch requires a trusted workspace. Login and status run directly as terminal processes; after they finish, use **Open CLI** for an interactive session.

References: [Claude credential isolation](https://code.claude.com/docs/en/authentication#credential-management), [Codex credential storage](https://developers.openai.com/codex/auth), [Codex configuration locations](https://developers.openai.com/codex/config-advanced).
