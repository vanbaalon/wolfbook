# Wolfbook on Windows — Build, Package, and Install

This guide documents the full Windows workflow for building the native WSTP
backend, running the test suite, and packaging/installing the VS Code extension.

**TL;DR** — if you just want to run everything at once, jump to
[§ One-command build](#one-command-build).

It is based on a verified end-to-end build on Windows 11 with Node.js 22 and
Wolfram Engine 14.2 / 14.3.

---

## 1) Prerequisites

### Required software

- **Wolfram Engine / Mathematica** (local install)
- **Node.js** (recommended: `20.17+` or `22+`)
- **Git**
- **Visual Studio 2022 Build Tools** with **Desktop development with C++**

### Install commands (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Microsoft.VisualStudio.2022.BuildTools
```

Then in Visual Studio Installer, ensure these are installed:

- MSVC v143 toolset
- Windows 10/11 SDK
- Desktop development with C++ workload

---

## 2) Clone repositories

From a common parent folder:

```powershell
git clone https://github.com/vanbaalon/wolfbook
git clone https://github.com/vanbaalon/mathematica-wstp-node "WSTP Backend"
```

Expected layout:

```text
<parent>/
  wolfbook/
  WSTP Backend/
```

---

## One-command build

The script `build-and-package.ps1` (in the wolfbook root) automates every step
below. It auto-detects your Wolfram Engine version, builds wstp.node, runs the
test suite against every installed kernel, packages the VSIX, and optionally
installs it into VS Code.

```powershell
# From inside the wolfbook repo:
Set-ExecutionPolicy -Scope Process Bypass   # allow unsigned scripts this session
.\build-and-package.ps1 -Install
```

Common flags:

| Flag | Description |
|---|---|
| `-Install` | Install the finished VSIX into VS Code automatically |
| `-SkipTests` | Skip the WSTP test suite (faster, use for quick iteration) |
| `-WolframEngineVersion 14.2` | Pin a specific engine (default: highest installed) |
| `-WstpNodeDir <path>` | Override the mathematica-wstp-node clone location |

If `mathematica-wstp-node` is not found at the default sibling path the script
clones it automatically from GitHub on branch `windows-x64`.

---

## Manual step-by-step

Follow this section only if you need to debug a specific step or the script
fails.

### 3) Set `WSTP_DIR`

`WSTP_DIR` must point to the `CompilerAdditions` folder inside the Wolfram
Engine SDK, which contains `wstp.h` and `wstp64i4s.lib`.

```powershell
# Replace 14.2 with your engine version
$env:WSTP_DIR = "C:\Program Files\Wolfram Research\Wolfram Engine\14.2\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"
```

### 4) Build the WSTP backend

```powershell
Set-Location "<parent>\mathematica-wstp-node"
git checkout windows-x64
npm install
npx node-gyp rebuild --msvs_version 2022
```

Critical notes:
- `--msvs_version 2022` is required with Visual Studio Build Tools 2022.
- `WSTP_DIR` must be set before the build; `binding.gyp` reads it directly.

Output binary:

```text
<parent>\mathematica-wstp-node\build\Release\wstp.node
```

### 5) Run the test suite (optional but recommended)

The test suite verifies evaluation, abort, dialog, Dynamic, and subAuto flows.

```powershell
Set-Location "<parent>\mathematica-wstp-node"
# Edit tests\test.js line 1: set KERNEL_PATH to your WolframKernel.exe, using double backslash:
# const KERNEL_PATH = 'C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.2\\WolframKernel.exe';
node tests\test.js
```

Expected: all ~71 numbered tests pass. Three tests (29, 31, 52) are known to be
timing-sensitive on some machines and may occasionally fail — they are not
blocking for the VSIX build.

### 6) Copy binary into Wolfbook

```powershell
Copy-Item "<parent>\mathematica-wstp-node\build\Release\wstp.node" `
          "<parent>\wolfbook\wstp\prebuilt\wstp-win32-x64.node" -Force
```

### 7) Package the VSIX

`wolfbook` ships with pre-compiled JS in `out/` (no TypeScript compilation step
is needed on Windows). Just install npm dev dependencies so `vsce` is available,
then package:

```powershell
Set-Location "<parent>\wolfbook"
npm install
vsce package --no-dependencies
```

Output: `wolfbook-<version>.vsix` in the current directory.

> **Note:** `--no-dependencies` is correct here. The `out/` directory is version
> controlled and `vsce` does not need to bundle `node_modules`.

### 8) Install locally in VS Code

```powershell
code --install-extension .\wolfbook-<version>.vsix --force
```

Then run **Developer: Reload Window** (Ctrl+Shift+P → Reload Window).

---

## Troubleshooting

### `gyp ERR! find VS` / cannot find Visual Studio

- Install VS 2022 Build Tools + **Desktop development with C++** workload.
- Restart the terminal after installation.

### `LNK1181: cannot open input file 'wstp64i4s.lib'`

- `WSTP_DIR` is not set or points to the wrong directory.
- The correct path ends in `\CompilerAdditions` and must contain both
  `wstp.h` and `wstp64i4s.lib`.

### `SyntaxError: Octal escape sequences are not allowed in strict mode`

- This appears in `tests\test.js` when `KERNEL_PATH` contains un-escaped
  backslashes (`\1`, `\W`, etc. are treated as octal/escapes in strict mode).
- Use **double backslash** in the JS string:
  `'C:\\Program Files\\Wolfram Research\\...'`

### Winsock/RPC unresolved externals (`WSAGetLastError`, `UuidCreate`, etc.)

- Ensure `binding.gyp` lists these libs under `OS=='win'`:
  `ws2_32.lib`, `rpcrt4.lib`

### `npx` fails with missing `%APPDATA%\npm`

```powershell
New-Item -ItemType Directory -Path "$env:APPDATA\npm" -Force
```

### `npm install` fails with lockfile errors

- Use `npm install` (not `npm ci`) for local builds until the lockfile is
  synchronized with the upstream repo.

---

## C++ platform guard conventions

All Windows-specific code in the C++ addon uses `#ifdef _WIN32` guards. The
pattern used for the `kill()` shim (POSIX API missing on Windows) is:

```cpp
#ifdef _WIN32
#  include <windows.h>
#  ifndef SIGTERM
#    define SIGTERM 15
#  endif
#  ifndef SIGKILL
#    define SIGKILL 9
#  endif
// On Windows, kill() doesn't exist — use TerminateProcess instead.
static int kill(pid_t pid, int /*sig*/) {
    HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
    if (!h) return -1;
    BOOL ok = TerminateProcess(h, 1);
    CloseHandle(h);
    return ok ? 0 : -1;
}
#endif
```

Standard headers `<signal.h>` and `<sys/types.h>` are present in the MSVC CRT
and do not need guards.

---

## Release checklist

- [ ] `wstp-win32-x64.node` built from current `windows-x64` branch source
- [ ] Binary copied to `wolfbook/wstp/prebuilt/wstp-win32-x64.node`
- [ ] Test suite passed on at least one kernel (failures logged)
- [ ] VSIX packaged with `vsce package --no-dependencies`
- [ ] Local install and kernel tested in VS Code
- [ ] `wstp-win32-x64.node` committed to wolfbook repo
- [ ] Both repos pushed to GitHub