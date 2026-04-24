# Building from Source

→ [Back to README](../README.md)

The prebuilt `.vsix` release contains native addons compiled for **macOS** (Apple Silicon and Intel). If you are on Windows, or want to modify the addons, you need to build from source.

---

## Repository Structure

```
wolfbook/
├── out/                   # Compiled TypeScript/JavaScript
├── wstp/                  # WSTP native addon source (mathematica-wstp-node)
├── wllatex-addon/         # wolfbook-btl (Box-to-LaTeX) addon source
├── media/                 # Webview assets (KaTeX, CSS, JS)
├── syntaxes/              # Wolfram Language grammar files
├── dev/                   # Developer notes and architecture docs
├── package.json
└── README.md
```

The two native addons are also maintained as separate repositories:

- [mathematica-wstp-node](https://github.com/vanbaalon/mathematica-wstp-node) — WSTP kernel connector
- wolfbook-btl — Box-to-LaTeX renderer (bundled in `wllatex-addon/`)

---

## Prerequisites

- Node.js 18+ and npm
- Python 3.x (for `node-gyp`)
- C++ build tools:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Visual Studio Build Tools with "Desktop development with C++" workload
- Wolfram Mathematica or Wolfram Engine installed (for the WSTP headers)
- `vsce` (VS Code extension packaging tool): `npm install -g @vscode/vsce`

---

## Building on macOS

```bash
git clone https://github.com/vanbaalon/wolfbook.git
cd wolfbook

# Install Node dependencies
npm install

# Build the WSTP addon
cd wstp
npm install
node-gyp rebuild
cd ..

# Build the wolfbook-btl addon
cd wllatex-addon
npm install
node-gyp rebuild
cd ..

# Compile TypeScript
npm run compile

# Package the extension
vsce package
```

This produces `wolfbook-x.y.z.vsix`. Install it:

```bash
code --install-extension wolfbook-x.y.z.vsix
```

Or via the Extensions panel: `⋯ → Install from VSIX…`

---

## Building on Windows

Windows support requires manual compilation of the native addons. The process is the same as macOS but with these differences:

1. Install Visual Studio Build Tools with "Desktop development with C++" workload
2. Set the WSTP library path in `wstp/binding.gyp` to point to your Wolfram installation
3. Run the build steps above in a Developer Command Prompt

See `build-windows.bat` for the scripted equivalent.

> ⚠️ Windows builds are not yet fully tested. Please report issues via the GitHub issue tracker.

---

## Configuring the Wolfram Kernel Path for the Build

The WSTP addon needs to find the Wolfram kernel headers and libraries at build time. Set the environment variable:

```bash
export WOLFRAM_HOME=/Applications/Mathematica.app/Contents
# or for Wolfram Engine:
export WOLFRAM_HOME=/usr/local/Wolfram/WolframEngine/14.x
```

---

## Development Workflow

```bash
# Watch TypeScript for changes
npm run watch

# In VS Code: press F5 to open the Extension Development Host
# Changes to TypeScript are picked up automatically
# Changes to native addons require rebuilding the addon and reloading the host
```

The `dev/` directory contains architecture notes on the kernel communication protocol, the btl rendering pipeline, and the notebook serialisation format.

---

## Reporting Bugs

Wolfbook is just over a month old. Please use the [GitHub issue tracker](https://github.com/vanbaalon/wolfbook/issues) to report bugs. Include:

- Your OS and VS Code version
- Wolfram Mathematica / Engine version
- The full error message from the VS Code Developer Console (`Help → Toggle Developer Tools`)
- A minimal `.wb` file that reproduces the problem, if applicable

We will try to fix issues as quickly as possible.
