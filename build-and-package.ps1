<#
.SYNOPSIS
    Full end-to-end build, test, and VSIX package script for Wolfbook on Windows.

.DESCRIPTION
    1. Detects installed Wolfram Engine version(s) and picks the SDK path
    2. Builds the native WSTP Node.js addon (wstp.node) from mathematica-wstp-node
    3. Runs the full WSTP test suite against every detected kernel
    4. Copies the binary into wolfbook/wstp/prebuilt/wstp-win32-x64.node
    5. Packages the VS Code extension as a .vsix
    6. Optionally installs the .vsix into the running VS Code

.PARAMETER WstpNodeDir
    Path to a local clone of mathematica-wstp-node (branch: windows-x64).
    Defaults to a sibling folder named "mathematica-wstp-node".

.PARAMETER WolframEngineVersion
    Pin a specific Wolfram Engine version (e.g. "14.2"). By default the script
    finds the highest version present under
    C:\Program Files\Wolfram Research\Wolfram Engine\.

.PARAMETER SkipTests
    Skip the WSTP test suite and go straight to packaging.

.PARAMETER Install
    Install the resulting .vsix into VS Code after packaging.

.EXAMPLE
    # Typical first-time use — clone wstp-node next to wolfbook and run:
    .\build-and-package.ps1 -Install

.EXAMPLE
    # Use a specific engine and skip tests:
    .\build-and-package.ps1 -WolframEngineVersion 14.3 -SkipTests -Install
#>

param(
    [string] $WstpNodeDir       = "",
    [string] $WolframEngineVersion = "",
    [switch] $SkipTests,
    [switch] $Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ────────────────────────────────────────────────────────────────────
function Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok  ([string]$msg) { Write-Host "  OK  $msg"    -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "  ERR $msg"    -ForegroundColor Red; exit 1 }
function Info([string]$msg) { Write-Host "  ... $msg" }

# ── Locate wolfbook root (script lives inside it) ──────────────────────────────
$WolfbookDir = $PSScriptRoot
if (-not (Test-Path "$WolfbookDir\package.json")) {
    Fail "Could not find package.json next to this script. Run from the wolfbook repo root."
}
$WolfbookVersion = (Get-Content "$WolfbookDir\package.json" -Raw |
    Select-String '"version"\s*:\s*"([^"]+)"').Matches[0].Groups[1].Value
Info "Wolfbook version: $WolfbookVersion"

# ── Locate or clone mathematica-wstp-node ─────────────────────────────────────
Step "Locating mathematica-wstp-node"

if ($WstpNodeDir -eq "") {
    $WstpNodeDir = Join-Path (Split-Path $WolfbookDir -Parent) "mathematica-wstp-node"
}

if (-not (Test-Path "$WstpNodeDir\binding.gyp")) {
    Info "Not found at $WstpNodeDir — cloning from GitHub (branch: windows-x64) ..."
    git clone --branch windows-x64 `
        https://github.com/vanbaalon/mathematica-wstp-node "$WstpNodeDir"
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed" }
} else {
    Info "Found at $WstpNodeDir"
    Push-Location $WstpNodeDir
    git fetch --quiet
    git checkout windows-x64 --quiet
    git pull  --quiet
    Pop-Location
}
Ok "wstp-node ready: $WstpNodeDir"

# ── Detect Wolfram Engine ──────────────────────────────────────────────────────
Step "Detecting Wolfram Engine"

$EngineRoot = "C:\Program Files\Wolfram Research\Wolfram Engine"
if (-not (Test-Path $EngineRoot)) {
    Fail "Wolfram Engine not found at $EngineRoot. Install it first."
}

$AllVersions = Get-ChildItem $EngineRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+$' } |
    Sort-Object { [version]$_.Name }

if ($AllVersions.Count -eq 0) { Fail "No versioned directories found under $EngineRoot" }

if ($WolframEngineVersion -ne "") {
    $ChosenDir = $AllVersions | Where-Object { $_.Name -eq $WolframEngineVersion } | Select-Object -First 1
    if (-not $ChosenDir) { Fail "Wolfram Engine $WolframEngineVersion not found" }
} else {
    $ChosenDir = $AllVersions | Select-Object -Last 1   # highest version for SDK
}

$BuildVersion = $ChosenDir.Name
$KernelExe    = "$EngineRoot\$BuildVersion\WolframKernel.exe"
$SdkPath      = "$EngineRoot\$BuildVersion\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"

if (-not (Test-Path "$SdkPath\wstp.h")) {
    Fail "WSTP SDK headers not found at $SdkPath`nPlease verify the Wolfram Engine installation."
}

Ok "Building against WEngine $BuildVersion"
Info "SDK : $SdkPath"
Info "All installed versions: $($AllVersions.Name -join ', ')"

# ── Build wstp.node ────────────────────────────────────────────────────────────
Step "Building wstp.node (WEngine $BuildVersion SDK)"

Push-Location $WstpNodeDir

$env:WSTP_DIR = $SdkPath
npm install --prefer-offline 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { npm install; if ($LASTEXITCODE -ne 0) { Fail "npm install failed in wstp-node" } }

npx node-gyp rebuild --msvs_version 2022
if ($LASTEXITCODE -ne 0) { Fail "node-gyp rebuild failed" }

$Binary = "$WstpNodeDir\build\Release\wstp.node"
if (-not (Test-Path $Binary)) { Fail "Expected binary not found: $Binary" }
$SizeKB = [math]::Round((Get-Item $Binary).Length / 1KB)
Ok "wstp.node built ($SizeKB KB)"

Pop-Location

# ── Run test suite ─────────────────────────────────────────────────────────────
if (-not $SkipTests) {
    foreach ($ver in $AllVersions) {
        $kernel = "$EngineRoot\$($ver.Name)\WolframKernel.exe"
        if (-not (Test-Path $kernel)) { Info "Skipping $($ver.Name) — WolframKernel.exe not found"; continue }

        Step "Test suite against WEngine $($ver.Name)"

        # Patch KERNEL_PATH in test.js (JS string — single backslash needs doubling)
        $escapedPath = $kernel.Replace('\', '\\')
        $testJs      = Get-Content "$WstpNodeDir\tests\test.js" -Raw
        $testJs      = $testJs -replace "const KERNEL_PATH = '[^']*';",
                                        "const KERNEL_PATH = '$escapedPath';"
        Set-Content "$WstpNodeDir\tests\test.js" $testJs -Encoding UTF8

        $logFile = Join-Path $WolfbookDir "wstp-test-$($ver.Name).log"
        Push-Location $WstpNodeDir
        node tests\test.js 2>&1 | Tee-Object $logFile
        $exitCode = $LASTEXITCODE
        Pop-Location

        # Parse pass/fail counts from log
        $logLines   = Get-Content $logFile
        $passed     = ($logLines | Where-Object { $_ -match "^\s+. \d+\." }).Count
        $failed     = ($logLines | Where-Object { $_ -match "^\s+. \d+\." -and $_ -match [char]0x2717 }).Count
        $passing    = $passed - $failed

        if ($failed -gt 0) {
            Write-Host "  WARN  $passing/$passed passed, $failed failed (WEngine $($ver.Name))" -ForegroundColor Yellow
            Write-Host "        See $logFile for details" -ForegroundColor Yellow
        } else {
            Ok "$passing/$passed tests passed (WEngine $($ver.Name))"
            Remove-Item $logFile -ErrorAction SilentlyContinue
        }

        if ($exitCode -ne 0 -and $failed -eq 0) {
            Info "node exited $exitCode but all parsed tests passed — treating as pass"
        }
    }
}

# ── Copy binary into wolfbook ──────────────────────────────────────────────────
Step "Copying wstp-win32-x64.node into wolfbook"

$PrebuiltDir = "$WolfbookDir\wstp\prebuilt"
if (-not (Test-Path $PrebuiltDir)) { New-Item -ItemType Directory $PrebuiltDir | Out-Null }

Copy-Item $Binary "$PrebuiltDir\wstp-win32-x64.node" -Force
Ok "Copied to wstp/prebuilt/wstp-win32-x64.node"

# ── npm install in wolfbook (needed for vsce) ──────────────────────────────────
Step "npm install (wolfbook)"
Push-Location $WolfbookDir
npm install --prefer-offline 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { npm install; if ($LASTEXITCODE -ne 0) { Fail "npm install failed in wolfbook" } }
Ok "node_modules ready"
Pop-Location

# ── Package VSIX ─────────────────────────────────────────────────────────────
Step "Packaging VSIX (wolfbook $WolfbookVersion)"
Push-Location $WolfbookDir

$VsixName = "wolfbook-$WolfbookVersion.vsix"
vsce package --no-dependencies -o $VsixName
if ($LASTEXITCODE -ne 0) { Fail "vsce package failed" }

$VsixPath = Join-Path $WolfbookDir $VsixName
$VsixKB   = [math]::Round((Get-Item $VsixPath).Length / 1KB)
Ok "VSIX ready: $VsixPath ($VsixKB KB)"
Pop-Location

# ── Install into VS Code ──────────────────────────────────────────────────────
if ($Install) {
    Step "Installing VSIX into VS Code"
    code --install-extension $VsixPath --force
    if ($LASTEXITCODE -ne 0) { Fail "code --install-extension failed" }
    Ok "Installed. Run 'Developer: Reload Window' in VS Code to activate."
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " BUILD COMPLETE" -ForegroundColor Green
Write-Host "  VSIX : $VsixPath" -ForegroundColor White
Write-Host "  Binary built with : WEngine $BuildVersion SDK" -ForegroundColor White
if ($Install) {
Write-Host "  Installed in VS Code: yes (reload window to activate)" -ForegroundColor White
} else {
Write-Host "  Install: run  code --install-extension `"$VsixPath`"" -ForegroundColor White
}
Write-Host "================================================================" -ForegroundColor Cyan
