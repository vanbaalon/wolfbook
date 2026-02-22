# Building Wolfbook

`npm` and `vsce` must be installed on your system.

- Get npm: https://www.npmjs.com/get-npm
- Install vsce: `npm install -g @vscode/vsce`

## Packaging

```
vsce package
```

This produces `wolfbook-2.0.0.vsix` in the project directory.

> **Note:** The build step is skipped (`vscode:prepublish` is a no-op) because the
> `out/` files are pre-built and edited directly. No TypeScript compilation needed.

## Installing

Install the generated `.vsix` from the VS Code command line:

```
code --install-extension wolfbook-2.0.0.vsix
```

Or via the Extensions panel: `...` → "Install from VSIX..."

After installing, reload VS Code (`Cmd+Shift+P` → "Developer: Reload Window").

## Quick deploy without repackaging

For fast iteration, copy changed files directly to the active extension:

```bash
EXT=~/.vscode/extensions/wolfbook.wolfbook-2.0.0
cp out/extension/controller.js $EXT/out/extension/controller.js
# Then: Developer: Reload Window
```
