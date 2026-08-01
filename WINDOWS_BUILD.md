# Wolfbook — Windows Build & Patch Notes

**Audience:** Windows developers building or maintaining the Wolfbook VS Code extension.

This file documents Windows-specific steps and known issues that arise after each upstream pull.
It lives alongside `RELEASE_GUIDE.md` in the repo root — read both.

---

## 1. Prerequisites

| Tool | Required version | Notes |
|------|-----------------|-------|
| Node.js | **v20.x** (ABI 115) | Must match VS Code's embedded Node |
| Visual Studio Build Tools | 2022 | For node-gyp / `wstp.node` |
| `@vscode/vsce` | latest | `npm install -g @vscode/vsce` |

Check your Node version before every build:

```powershell
node --version                    # must print v20.x.y
node -p "process.versions.modules"  # must print 115
```

If not, switch via `nvm use 20` or install Node 20 from nodejs.org.

---

## 2. After every `git pull` from main — checklist

Run through this after rebasing onto a new upstream commit:

```powershell
git pull --rebase --autostash
```

Then check each item below.

### 2.1  Validate JS files before packaging

After resolving any stash/rebase conflicts, always syntax-check the key files:

```powershell
node -e "require('fs').readFileSync('out/extension/dynamic/subsession.js','utf8'); console.log('subsession OK')"
node -e "require('fs').readFileSync('out/extension/debugger/watchPanel.js','utf8'); console.log('watchPanel OK')"
node -e "require('fs').readFileSync('out/extension/execution/wb-export.js','utf8'); console.log('wb-export OK')"
```

If any file fails with `SyntaxError`, restore it from origin:

```powershell
git checkout origin/main -- out/extension/dynamic/subsession.js
git checkout origin/main -- out/extension/debugger/watchPanel.js
git checkout origin/main -- out/extension/execution/wb-export.js
```

### 2.2  package.json corruption

`package.json` can get silently corrupted by:
- PowerShell `Set-Content` (adds UTF-8 BOM)
- Leftover `<<<<<<` / `=======` / `>>>>>>>` conflict markers from autostash

**Never** edit `package.json` with PowerShell `Set-Content` or `Out-File` without explicit encoding.

If corrupted (vsce or npm fail with parsing errors), restore:

```powershell
git checkout origin/main -- package.json
```

Verify the file is clean (first bytes must be `7B 20` = `{ `):

```powershell
$bytes = [System.IO.File]::ReadAllBytes("package.json") | Select-Object -First 4
$bytes -join ','   # should print: 123,32,32,32  (not 239,187,191 = BOM)
```

### 2.3  KaTeX in wllatex-addon

`watchPanel.js` and `katexPrerender.js` expect KaTeX to be installed at
`wllatex-addon/node_modules/katex`.

On Mac the `VSCodeWolfbookLaTeX` build system installs this automatically.
On Windows we install it manually from `wllatex-addon/package.json`:

```powershell
cd wllatex-addon
npm install --omit=dev      # installs katex ~500 KB into wllatex-addon/node_modules
cd ..
```

`wllatex-addon/node_modules/` is git-ignored; it is included in the VSIX automatically.
The `watch-and-rebuild.ps1` script handles this automatically.

**Sign of failure:** Watch panel renders empty boxes instead of LaTeX symbols.

---

## 3. Building wstp.node on Windows

Use the `windows-x64` branch of `mathematica-wstp-node`.
Full steps are in `RELEASE_GUIDE.md §4.2`. Quick reference:

```powershell
cd ..\mathematica-wstp-node
git checkout windows-x64
$env:WSTP_DIR = "C:\Program Files\Wolfram Research\Wolfram Engine\14.2\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"
$env:npm_config_msvs_version = "2022"
npm install
npx node-gyp rebuild
copy build\Release\wstp.node ..\wolfbook-win\wstp\prebuilt\wstp-win32-x64.node
```

Adjust the Engine version in `$env:WSTP_DIR` if you have a different version.
The `watch-and-rebuild.ps1` script detects the highest installed engine automatically.

---

## 4. Packaging the VSIX

Always use `--target win32-x64 --allow-missing-repository`:

```powershell
cd %USERPROFILE%\wolfbook-win
vsce package --allow-missing-repository --target win32-x64 -o wolfbook-<version>-win32-x64.vsix
```

`*.vsix` is in `.gitignore`. To push it to git:

```powershell
git add -f wolfbook-<version>-win32-x64.vsix
git commit -m "chore(release): v<version> win32-x64 VSIX"
git push
```

---

## 5. Deploying locally (manual install)

Expand the VSIX into the running extension folder so you don't need to restart VS Code:

```powershell
$ver = "2.6.0"
$vsix = "$env:USERPROFILE\wolfbook-win\wolfbook-$ver-win32-x64.vsix"
$zip  = "$vsix.zip"
$tmp  = "$env:USERPROFILE\wolfbook-win\.tmp-vsix-expand"
$dest = "$env:USERPROFILE\.vscode\extensions\wolfbook.wolfbook-$ver"

Copy-Item $vsix $zip -Force
Expand-Archive $zip $tmp -Force
Copy-Item "$tmp\extension\*" $dest -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force
```

Then in VS Code: **Developer: Reload Window**.

**Verify clean load** — check the exthost log for SyntaxError:

```powershell
Get-Content "$env:APPDATA\Code\logs\*\exthost*\output_logging_*\1-Wolf*.log" -Tail 30 -ErrorAction SilentlyContinue
```

---

## 6. Automated build (Scheduled Task)

`watch-and-rebuild.ps1` runs every 15 minutes as a Windows Scheduled Task.
It handles all of the above automatically:
- Detects upstream changes in `wolfbook` and `mathematica-wstp-node/windows-x64`
- Compiles `wstp.node` using the highest installed Wolfram Engine SDK
- Runs `npm install` in `wllatex-addon/` for KaTeX
- Asserts Node ABI = 115 (exits with a helpful message if wrong)
- Packages with `--target win32-x64`
- Force-adds the VSIX to git and pushes

Register the task (one-time, from an elevated PowerShell):

```powershell
.\watch-and-rebuild.ps1 -RegisterTask
```

Test without committing:

```powershell
.\watch-and-rebuild.ps1 -DryRun
```

---

## 7. Known Windows-specific issues (resolved)

| Issue | Version | Fix |
|-------|---------|-----|
| `Dynamic[...]` returns `$Failed` for expressions that generate messages | 2.5.x | Removed `Check[..., $Failed]` wrapper from `VsCodeDynExportValue` in `resources/api.wl` — see commit notes |
| KaTeX CSS not found → blank math in watch panel | 2.5.11–2.5.13 | Moved KaTeX to `wllatex-addon/node_modules/` (via local `package.json`) |
| `subsession.js` SyntaxError at line 826 (2.6.0) | 2.6.0 | Old debug-instrumented version (780 lines) was packaged instead of upstream clean version (777 lines). Fix: `git checkout origin/main -- out/extension/dynamic/subsession.js` |
| `package.json` BOM corruption | 2.6.0 | PowerShell `Set-Content` adds UTF-8 BOM. Fix: `git checkout origin/main -- package.json` |
| `renderer.js` / `watchPanel.js` / `wb-export.js` deleted after `git pull` | 2.6.0 | Files deleted by autostash re-apply. Fix: `git checkout origin/main -- <file>` |
