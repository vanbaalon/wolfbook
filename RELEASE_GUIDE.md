# Wolfbook — Multi-Platform Release Guide

**Audience:** developers building and releasing Wolfbook for the VS Code Marketplace.

---

## 1. Target platforms

| VS Code `--target` | Machine | Status |
|--------------------|---------|--------|
| `darwin-arm64` | Mac Apple Silicon (M1/M2/M3/…) | ✅ binaries compiled |
| `darwin-x64` | Mac Intel (x86-64) | ⚠️ **needs compile** |
| `win32-x64` | Windows 10/11, 64-bit | ✅ binaries compiled |

---

## 2. Two native addons per platform

Both addons are compiled per-platform and committed to the extension git repo before packaging.

| Addon | Source repo | Compiled output | Extension prebuilt location |
|-------|-------------|-----------------|----------------------------|
| `wstp.node` | `WSTP Backend/` | `build/Release/wstp.node` | `wstp/prebuilt/wstp-<plat>-<arch>.node` |
| `wolfbook_btl.node` | `VSCodeWolfbookLaTeX/` | `build/Release/wolfbook_btl.node` | `wllatex-addon/prebuilt/wolfbook_btl-<plat>-<arch>.node` |

The extension's loader checks the prebuilt path first and falls back to the ad-hoc build:

```
wstp.node      → wstp/prebuilt/wstp-${process.platform}-${process.arch}.node
                 fallback: wstp/build/Release/wstp.node

wolfbook_btl   → wllatex-addon/prebuilt/wolfbook_btl-${process.platform}-${process.arch}.node
                 fallback: wllatex-addon/wolfbook_btl.node
```

---

## 3. Critical: Node.js version must match VS Code

Native addons are compiled against a specific **Node ABI**. If the ABI mismatches VS Code's
embedded Node, the addon will fail to load with `invalid ELF header` / `was compiled against
a different Node.js version`.

| VS Code version | Electron | Node.js | ABI |
|-----------------|----------|---------|-----|
| 1.100 – 1.113 | 32.x | 20.x | **115** |

**Always compile with Node.js 20.x.** Check your active version:

```bash
node --version   # must print v20.x.y
node -p "process.versions.modules"  # must print 115
```

If you manage multiple Node versions (nvm, volta, etc.):

```bash
nvm use 20      # or: nvm use lts/iron
```

---

## 4. Compiling `wstp.node`

### 4.1 Mac — ARM64 and Intel (same command, arch auto-detected)

```bash
cd "WSTP Backend"
npm install          # first time only; installs node-addon-api / node-gyp
bash build.sh        # Release build → build/Release/wstp.node
```

The script detects `uname -m` and selects the correct WSTP SDK sub-directory
(`MacOSX-ARM64` or `MacOSX-x86-64`) inside the Wolfram app bundle automatically.

If Wolfram is not installed at `/Applications/Wolfram 3.app`:

```bash
WOLFRAM_APP=/Applications/Mathematica.app bash build.sh
```

Copy the result to the extension:

```bash
PLAT=$(node -p "process.platform")   # darwin
ARCH=$(node -p "process.arch")       # arm64 or x64
cp build/Release/wstp.node \
   "../Extension Development/wstp/prebuilt/wstp-${PLAT}-${ARCH}.node"
echo "Copied → wstp-${PLAT}-${ARCH}.node"
```

### 4.2 Windows x64

> See `WINDOWS_BUILD.md` in the `WSTP Backend/` folder for the full Windows guide.

Quick reference:

```powershell
cd "WSTP Backend"
git fetch origin
git checkout windows-x64          # contains the MSVC portability patches

$env:WSTP_DIR = "C:\Program Files\Wolfram Research\Mathematica\XX.X\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"

npm install                        # uses binding.gyp / node-gyp
# Output: build\Release\wstp.node
```

Copy to the extension (adjust paths as needed):

```powershell
copy build\Release\wstp.node `
     "..\Extension Development\wstp\prebuilt\wstp-win32-x64.node"
```

Also update the WSTP repo's own prebuilt for reference:

```powershell
copy build\Release\wstp.node prebuilds\win32-x64\wstp.node
```

#### Windows branch strategy

The `windows-x64` branch has three `#ifdef _WIN32` portability changes over `main`
(`pid_t` typedef, `kill()` shim, Winsock linker flags). These are self-contained.

When `main` receives new C++ changes:

```bash
git checkout windows-x64
git rebase main          # or: git merge main
# resolve conflicts if any (expect none — all Windows diffs are #ifdef-guarded)
git push origin windows-x64 --force-with-lease
```

**Do NOT merge `windows-x64` back into `main`** — the branch exists purely so Windows
developers can compile without patching files manually each time.

---

## 5. Compiling `wolfbook_btl.node`

### 5.1 Mac — ARM64 and Intel

```bash
cd VSCodeWolfbookLaTeX
./build.sh native     # C++ addon only (skips TypeScript)
# Output: build/Release/wolfbook_btl.node
```

Copy to the extension:

```bash
PLAT=$(node -p "process.platform")
ARCH=$(node -p "process.arch")
cp build/Release/wolfbook_btl.node \
   "../VSCodeWolframExtension/Extension Development/wllatex-addon/prebuilt/wolfbook_btl-${PLAT}-${ARCH}.node"
echo "Copied → wolfbook_btl-${PLAT}-${ARCH}.node"
```

### 5.2 Windows x64

WolfbookLaTeX Windows build is documented separately. The pre-compiled binary is already
at `wllatex-addon/prebuilt/wolfbook_btl-win32-x64.node`.

---

## 6. Git workflow — what to push where

### 6.1 WSTP Backend repo (`https://github.com/vanbaalon/mathematica-wstp-node`)

Push C++ source changes to `main`. The compiled binary itself is **not** stored
in the WSTP repo (except `prebuilds/win32-x64/wstp.node` on the `windows-x64` branch
for reference). The canonical compiled binaries live in the extension repo.

### 6.2 Extension repo (`https://github.com/vanbaalon/wolfbook`)

ALL prebuilt binaries are committed here. This is the single source of truth for
compiled artifacts.

After compiling a new binary on any platform:

```bash
cd "Extension Development"

# Stage only the prebuilt binaries (plus any source changes)
git add wstp/prebuilt/
git add wllatex-addon/prebuilt/
git add package.json CHANGELOG.md    # + any other changed files

git commit -m "v2.6.0: add darwin-x64 binaries, bump version"
git push origin main
```

> **Tip:** if `git add wstp/prebuilt/*.node` says "nothing to add", the files may be
> excluded by `.gitignore`. Run `git check-ignore -v wstp/prebuilt/wstp-darwin-x64.node`
> to diagnose. The `*.node` glob should **not** be in `.gitignore`.

### 6.3 What each person does

| Developer | Compiles | Copies binary to | Commits/pushes |
|-----------|----------|-----------------|----------------|
| Mac ARM64 (primary) | `wstp.node` + `wolfbook_btl.node` | `wstp/prebuilt/wstp-darwin-arm64.node` etc. | extension repo `main` |
| Mac Intel | `wstp.node` + `wolfbook_btl.node` | `wstp/prebuilt/wstp-darwin-x64.node` etc. | extension repo `main` |
| Windows | `wstp.node` (from `windows-x64` branch) | `wstp/prebuilt/wstp-win32-x64.node` | extension repo `main` |

Windows developer pulls extension repo first, adds the new binary, pushes. Mac
developers then pull before packaging.

---

## 7. Packaging VSIXes

### 7.1 Prerequisites (once)

```bash
npm install -g @vscode/vsce
```

### 7.2 Verify all binaries are present

```bash
cd "Extension Development"
echo "=== wstp prebuilt ===" && ls wstp/prebuilt/
echo "=== btl prebuilt ===" && ls wllatex-addon/prebuilt/
```

Expected output:

```
=== wstp prebuilt ===
wstp-darwin-arm64.node   wstp-darwin-x64.node   wstp-win32-x64.node

=== btl prebuilt ===
wolfbook_btl-darwin-arm64.node   wolfbook_btl-darwin-x64.node   wolfbook_btl-win32-x64.node
```

If any file is missing, compile it first (sections 4 and 5 above).

### 7.3 Package

All three VSIXes are packaged from the **Mac machine** (no Windows toolchain needed for
packaging — only the binary needs to have been compiled on Windows first).

```bash
cd "Extension Development"

VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")
VSIX_DIR="../Extension Production VSIX"
mkdir -p "$VSIX_DIR"

vsce package --allow-missing-repository \
     --target darwin-arm64 \
     -o "$VSIX_DIR/wolfbook-${VERSION}-darwin-arm64.vsix"

vsce package --allow-missing-repository \
     --target darwin-x64 \
     -o "$VSIX_DIR/wolfbook-${VERSION}-darwin-x64.vsix"

vsce package --allow-missing-repository \
     --target win32-x64 \
     -o "$VSIX_DIR/wolfbook-${VERSION}-win32-x64.vsix"

echo "Packages ready in: $VSIX_DIR"
ls -lh "$VSIX_DIR/"*.vsix
```

Each VSIX contains all three native binaries. VS Code loads only the one that matches the
running platform; the others are silently ignored. The size overhead is acceptable
(~3 × 2–4 MB extra).

### 7.4 Naming convention

```
wolfbook-<VERSION>-<vscode-target>.vsix

wolfbook-2.6.0-darwin-arm64.vsix   ← Mac Apple Silicon
wolfbook-2.6.0-darwin-x64.vsix     ← Mac Intel
wolfbook-2.6.0-win32-x64.vsix      ← Windows 64-bit
```

---

## 8. Uploading to the Marketplace

### 8.1 Via CLI

```bash
# Log in once with a PAT from https://dev.azure.com → User Settings → Personal access tokens
vsce login wolfbook

VERSION=$(node -p "JSON.parse(require('fs').readFileSync('Extension Development/package.json','utf8')).version")
VSIX_DIR="Extension Production VSIX"

vsce publish --packagePath "$VSIX_DIR/wolfbook-${VERSION}-darwin-arm64.vsix"
vsce publish --packagePath "$VSIX_DIR/wolfbook-${VERSION}-darwin-x64.vsix"
vsce publish --packagePath "$VSIX_DIR/wolfbook-${VERSION}-win32-x64.vsix"
```

### 8.2 Via web interface

1. Go to https://marketplace.visualstudio.com/manage
2. Find **Wolfbook — Wolfram Language Notebook**
3. Click **...** → **Update**
4. Upload each VSIX file individually — one per platform
5. Confirm the platform tag is shown correctly for each upload

---

## 9. Release checklist

Use this before every version release.

### Preparation
- [ ] Bump version in `Extension Development/package.json`
- [ ] Bump version in `WSTP Backend/package.json`
- [ ] Add entry to `Extension Development/CHANGELOG.md`

### Compile — only needed when C++ source changed
- [ ] **Mac ARM64**: `bash build.sh` in `WSTP Backend` → copy to `wstp/prebuilt/wstp-darwin-arm64.node`
- [ ] **Mac Intel**: `bash build.sh` in `WSTP Backend` → copy to `wstp/prebuilt/wstp-darwin-x64.node`
- [ ] **Windows**: `npm install` in `WSTP Backend` (windows-x64 branch) → copy to `wstp/prebuilt/wstp-win32-x64.node`
- [ ] **Mac ARM64**: `./build.sh native` in `VSCodeWolfbookLaTeX` → copy to `wllatex-addon/prebuilt/wolfbook_btl-darwin-arm64.node`
- [ ] **Mac Intel**: `./build.sh native` in `VSCodeWolfbookLaTeX` → copy to `wllatex-addon/prebuilt/wolfbook_btl-darwin-x64.node`

### Verify binaries
- [ ] `ls wstp/prebuilt/` — confirms 3 files
- [ ] `ls wllatex-addon/prebuilt/` — confirms 3 files

### Git
- [ ] `git add wstp/prebuilt/ wllatex-addon/prebuilt/ package.json CHANGELOG.md`
- [ ] `git commit -m "vX.Y.Z: <summary>"`
- [ ] `git push origin main`

### Package
- [ ] Run the 3× `vsce package` commands from section 7.3
- [ ] Confirm 3 `.vsix` files exist in `Extension Production VSIX/`

### Publish
- [ ] Upload all 3 VSIXes to Marketplace (section 8)
- [ ] Verify the new version appears on the Marketplace page

---

## 10. Troubleshooting

### `Error: Cannot require module '…/wstp-darwin-x64.node'`
The `darwin-x64` binary is missing. Compile it on an Intel Mac (section 4.1).

### `Error: The module was compiled against a different Node.js version`
The addon's ABI does not match VS Code's embedded Node. Recompile using Node.js 20.x
(ABI 115). Check with `node -p "process.versions.modules"`.

### `vsce package` fails with `ENOENT` for a `.node` file
A prebuilt binary is missing. Run the verify step (section 7.2) and compile the missing
one.

### Windows binary loads on Mac (or vice versa)
Not possible — the OS loader rejects wrong-platform ELF/PE/Mach-O files. The platform
check in controller.js picks the right file at runtime.

### `git add *.node` adds nothing
Check `.gitignore`:
```bash
git check-ignore -v wstp/prebuilt/wstp-darwin-x64.node
```
If it prints a rule, remove that rule from `.gitignore`.

### `windows-x64` branch is behind `main` after a C++ update
```bash
git checkout windows-x64
git rebase main
# Recompile on Windows after this
git push origin windows-x64 --force-with-lease
```
