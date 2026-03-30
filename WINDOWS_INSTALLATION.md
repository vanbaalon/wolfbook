# Wolfbook on Windows — Build, Package, and Install

This guide documents a working Windows flow to:

1. Compile the native WSTP backend (`wstp.node`) from source
2. Bundle it into a Windows VSIX
3. Install and verify Wolfbook locally

It is based on a successful end-to-end build on Windows 11.

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

## 3) Set `WSTP_DIR`

Set `WSTP_DIR` to Wolfram WSTP CompilerAdditions folder.

Example:

```powershell
$env:WSTP_DIR = "C:\Program Files\Wolfram Research\Wolfram\14.2\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"
```

The folder must contain:

- `wstp.h`
- `wstp64i4s.lib`

---

## 4) Build the WSTP backend

```powershell
Set-Location "<parent>\WSTP Backend"
npm install
npm run build
```

Output binary:

```text
<parent>\WSTP Backend\build\Release\wstp.node
```

---

## 5) Copy binary into Wolfbook

```powershell
Set-Location "<parent>"
Copy-Item ".\WSTP Backend\build\Release\wstp.node" ".\wolfbook\wstp\prebuilt\wstp-win32-x64.node" -Force
Copy-Item ".\WSTP Backend\build\Release\wstp.node" ".\wolfbook\wstp\build\Release\wstp.node" -Force
```

Both paths are used by the extension loader (prebuilt first, then fallback).

---

## 6) Build Windows VSIX

```powershell
Set-Location "<parent>\wolfbook"
npm install
npx --yes @vscode/vsce package --target win32-x64 --allow-missing-repository -o wolfbook-<version>-win32-x64.vsix
```

Example output:

```text
wolfbook-2.2.1-win32-x64.vsix
```

---

## 7) Install locally in VS Code

```powershell
code --install-extension .\wolfbook-<version>-win32-x64.vsix
```

Then run **Developer: Reload Window**.

---

## 8) Quick runtime smoke test (optional)

```powershell
Set-Location "<parent>\wolfbook"
node -e "const addon=require('./wstp/prebuilt/wstp-win32-x64.node'); const s=new addon.WstpSession('C:/Program Files/Wolfram Research/Wolfram/14.2/WolframKernel.exe',{interactive:true}); s.evaluate('1+1').then(r=>{console.log(r.result.value); s.close();}).catch(e=>{console.error(e); process.exit(1);});"
```

Expected output:

```text
2
```

---

## 9) Troubleshooting

### `gyp ERR! find VS` / cannot find Visual Studio

- Install VS 2022 Build Tools + C++ workload
- Restart terminal after installation

### `LNK1181: cannot open input file 'wstp64i4s.lib'`

- `WSTP_DIR` is wrong
- Re-point `WSTP_DIR` to the exact `CompilerAdditions` directory

### Winsock/RPC unresolved externals (`WSAGetLastError`, `UuidCreate`, etc.)

- Ensure Windows link libs are present in backend `binding.gyp` for `OS=='win'`:
  - `ws2_32.lib`
  - `rpcrt4.lib`

### `npx` fails with missing `%APPDATA%\npm`

```powershell
New-Item -ItemType Directory -Path "$env:APPDATA\npm" -Force
```

### `npm ci` fails in `WSTP Backend` due lockfile drift

- Use `npm install` instead of `npm ci` for local build until lockfile is synchronized.

---

## 10) Release handoff checklist (Windows)

- `wstp-win32-x64.node` built from current backend source
- binary copied to `wolfbook/wstp/prebuilt/wstp-win32-x64.node`
- Windows VSIX packaged with `--target win32-x64`
- local install and kernel launch smoke-tested

This artifact is then ready to share with maintainers for Marketplace release packaging.