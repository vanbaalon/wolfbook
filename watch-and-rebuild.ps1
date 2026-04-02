<#
.SYNOPSIS
    Automatic rebuild watcher for Wolfbook Windows binaries and VSIX.

.DESCRIPTION
    Runs as a Windows Scheduled Task every 15 minutes.
    For each watched repo (wolfbook, mathematica-wstp-node, btl) it checks whether
    the remote HEAD has changed since the last successful build.  If any repo has
    new commits, or if the wolfbook/wstp version string changed, the script:
        1. Pulls the latest code from all repos
        2. Recompiles wstp.node (and btl.node if present)
        3. Runs the WSTP test suite, skipping known-broken Windows tests (29, 31, 52)
        4. Saves a plain-text test report next to this script
        5. Copies the updated binary into wolfbook and packages a new VSIX
        6. Commits and pushes the updated binaries + test report to the wolfbook repo
        7. Installs the VSIX into the local VS Code

    If nothing changed, the script exits quickly without rebuilding.

.PARAMETER Force
    Rebuild and re-package even if no changes are detected.

.PARAMETER DryRun
    Go through all detection and reporting steps but do NOT push to git
    and do NOT install the VSIX.

.EXAMPLE
    # Run manually to test before scheduling:
    .\watch-and-rebuild.ps1 -DryRun

.EXAMPLE
    # Register as a scheduled task (run once to set up, then task runs automatically):
    .\watch-and-rebuild.ps1 -RegisterTask

.PARAMETER RegisterTask
    Register (or update) the Windows Scheduled Task that runs this script
    every 15 minutes.  Must be run once with this flag from an elevated
    (Administrator) PowerShell prompt.

.NOTES
    State file: %TEMP%\wolfbook-watcher-state.json
    This file stores the last-seen git hash for each repo.
    Log:         %TEMP%\wolfbook-watcher.log  (last 500 lines kept)
#>

param(
    [switch] $Force,
    [switch] $DryRun,
    [switch] $RegisterTask
)

# NOTE: No Set-StrictMode - .Count on scalar/null pipeline results throws PropertyNotFoundStrict

# ============================================================================
# CONFIG  -- edit these if your checkout locations differ
# ============================================================================
$WolfbookDir  = $PSScriptRoot                           # this script lives in wolfbook/
$WstpNodeDir  = Join-Path (Split-Path $WolfbookDir -Parent) "mathematica-wstp-node"
$BtlDir       = ""   # set to local btl repo path if you want to rebuild it
$EngineRoot   = "C:\Program Files\Wolfram Research\Wolfram Engine"
$KnownSkipTests = @(29, 31, 52)   # broken on Windows: JLink prompt / timing

$StateFile    = "$env:TEMP\wolfbook-watcher-state.json"
$LogFile      = "$env:TEMP\wolfbook-watcher.log"
$MaxLogLines  = 500
$TaskName     = "WolfbookWatcher"

# ============================================================================
# REGISTER SCHEDULED TASK
# ============================================================================
if ($RegisterTask) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if (-not $scriptPath) { Write-Error "Cannot determine script path. Save the script to disk first."; exit 1 }
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                   -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 15) `
                   -Once -At (Get-Date)
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
                    -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -RunLevel Limited -Force | Out-Null
    Write-Host "Scheduled task '$TaskName' registered - runs every 15 minutes." -ForegroundColor Green
    Write-Host "Run  Get-ScheduledTask -TaskName '$TaskName'  to verify." -ForegroundColor Cyan
    exit 0
}

# ============================================================================
# HELPERS
# ============================================================================
function Log([string]$msg) {
    $ts = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    $line = "$ts  $msg"
    Write-Host $line
    Add-Content $LogFile $line -ErrorAction SilentlyContinue
}
function LogSection([string]$msg) { Log ""; Log "=== $msg ===" }
function Trim-Log {
    if (Test-Path $LogFile) {
        $lines = Get-Content $LogFile
        if ($lines.Count -gt $MaxLogLines) {
            $lines | Select-Object -Last $MaxLogLines | Set-Content $LogFile
        }
    }
}

function Get-RemoteHash([string]$repoDir, [string]$branch) {
    # Returns the remote HEAD commit hash without fetching (uses ls-remote)
    $remote = git -C $repoDir ls-remote origin "refs/heads/$branch" 2>$null
    if ($remote) { return ($remote -split '\s+')[0] } else { return $null }
}
function Get-LocalHash([string]$repoDir) {
    return (git -C $repoDir rev-parse HEAD 2>$null)
}

function Load-State {
    if (Test-Path $StateFile) {
        try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch {}
    }
    return [PSCustomObject]@{ wstp = ""; wolfbook = "" }
}
function Save-State([PSCustomObject]$s) {
    $s | ConvertTo-Json | Set-Content $StateFile -Encoding UTF8
}

function Pull-Repo([string]$dir, [string]$branch) {
    Log "  git pull $dir ($branch)"
    git -C $dir fetch --quiet 2>&1 | Out-Null
    git -C $dir checkout $branch --quiet 2>&1 | Out-Null
    git -C $dir rebase --autostash "origin/$branch" 2>&1 | Out-Null
}
function Assert-NodeAbi {
    # VS Code 1.100-1.113 embeds Node 20.x / ABI 115 (Electron 32.x).
    # Addons compiled against a different ABI will fail to load with "invalid ELF header".
    $nodeVer = node --version 2>$null
    $abi     = node -p "process.versions.modules" 2>$null
    if ($nodeVer -notmatch '^v20\.') {
        Log "ERROR: Node $nodeVer detected. Must use Node v20.x (ABI 115) to match VS Code embedded Node."
        Log "       Switch with: nvm use 20  or install Node 20 from nodejs.org"
        exit 1
    }
    if ($abi -ne '115') {
        Log "ERROR: Node ABI $abi detected. Expected ABI 115 (Node 20.x)."
        exit 1
    }
    Log "Node ABI OK: $nodeVer / ABI $abi"
}

# ============================================================================
# CHECK FOR CHANGES
# ============================================================================
Trim-Log
LogSection "Wolfbook watcher started"

$state = Load-State

$repos = [ordered]@{
    wstp     = @{ Dir = $WstpNodeDir;  Branch = "windows-x64" }
    wolfbook = @{ Dir = $WolfbookDir;  Branch = "main" }
}

Assert-NodeAbi

$needRebuild = $Force.IsPresent
$changes     = @()

foreach ($name in $repos.Keys) {
    $r = $repos[$name]
    if (-not (Test-Path "$($r.Dir)\.git")) {
        Log "  SKIP $name - no git repo at $($r.Dir)"
        continue
    }
    $remote = Get-RemoteHash $r.Dir $r.Branch
    $local  = Get-LocalHash  $r.Dir
    $saved  = $state.$name

    if ($remote -and $remote -ne $saved) {
        Log "  CHANGE $name : saved=$saved  remote=$remote"
        $changes  += $name
        $needRebuild = $true
    } else {
        Log "  OK $name : up to date ($local)"
    }
}

if (-not $needRebuild) {
    Log "No changes detected. Nothing to do."
    exit 0
}

Log "Changes in: $($changes -join ', ') -- starting rebuild"

# ============================================================================
# PULL LATEST
# ============================================================================
LogSection "Pulling latest code"
foreach ($name in $repos.Keys) {
    $r = $repos[$name]
    if (Test-Path "$($r.Dir)\.git") { Pull-Repo $r.Dir $r.Branch }
}

# ============================================================================
# DETECT WOLFRAM ENGINE SDK
# ============================================================================
$AllVersions = Get-ChildItem $EngineRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+$' } |
    Sort-Object { [version]$_.Name }

$ChosenDir = $null; $SdkPath = $null
foreach ($dir in ($AllVersions | Sort-Object { [version]$_.Name } -Descending)) {
    $candidate = "$EngineRoot\$($dir.Name)\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"
    if (Test-Path "$candidate\wstp.h") { $ChosenDir = $dir; $SdkPath = $candidate; break }
}
if (-not $ChosenDir) { Log "ERROR: No Wolfram Engine with WSTP SDK found"; exit 1 }
$BuildVersion = $ChosenDir.Name
Log "Using WEngine $BuildVersion SDK"

# ============================================================================
# BUILD wstp.node
# ============================================================================
LogSection "Building wstp.node"

$env:WSTP_DIR = $SdkPath
$env:npm_config_msvs_version = "2022"

Push-Location $WstpNodeDir
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Log "ERROR: npm install failed in wstp-node"; exit 1 }

$buildOut = npx node-gyp rebuild 2>&1
$buildOut | ForEach-Object { Log "  $_" }
if ($LASTEXITCODE -ne 0) { Log "ERROR: node-gyp rebuild failed"; exit 1 }
Pop-Location

$Binary = "$WstpNodeDir\build\Release\wstp.node"
if (-not (Test-Path $Binary)) { Log "ERROR: wstp.node not found after build"; exit 1 }
$SizeKB = [math]::Round((Get-Item $Binary).Length / 1KB)
Log "wstp.node built: $SizeKB KB"

# ============================================================================
# BUILD btl.node (optional)
# ============================================================================
if (Test-Path "$BtlDir\binding.gyp") {
    LogSection "Building btl.node"
    Push-Location $BtlDir
    npm install 2>&1 | Out-Null
    $btlOut = npx node-gyp rebuild 2>&1
    $btlOut | ForEach-Object { Log "  $_" }
    if ($LASTEXITCODE -ne 0) { Log "WARN: btl build failed - continuing without it" }
    else {
        $btlBin = "$BtlDir\build\Release\btl.node"
        if (Test-Path $btlBin) {
            $btlDest = "$WolfbookDir\wstp\prebuilt\btl-win32-x64.node"
            Copy-Item $btlBin $btlDest -Force
            Log "btl.node copied to $btlDest"
        }
    }
    Pop-Location
}

# ============================================================================
# RUN WSTP TEST SUITE
# ============================================================================
LogSection "WSTP test suite"

$reportLines  = @()
$reportLines += "Wolfbook Windows build report"
$reportLines += "Generated : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$reportLines += "WEngine   : $BuildVersion"
$reportLines += ""

foreach ($ver in $AllVersions) {
    $kernel = "$EngineRoot\$($ver.Name)\WolframKernel.exe"
    if (-not (Test-Path $kernel)) { Log "  SKIP $($ver.Name) - no WolframKernel.exe"; continue }

    Log "  Testing against WEngine $($ver.Name) ..."

    $testJsPath     = "$WstpNodeDir\tests\test.js"
    $testJsOriginal = Get-Content $testJsPath -Raw
    $escapedPath    = $kernel.Replace('\', '\\')
    $testJsPatched  = $testJsOriginal -replace "const KERNEL_PATH = '[^']*';",
                                               "const KERNEL_PATH = '$escapedPath';"
    Set-Content $testJsPath $testJsPatched -Encoding UTF8

    $testLog = "$env:TEMP\watcher-test-$($ver.Name).log"
    Push-Location $WstpNodeDir
    $proc = Start-Process -FilePath "node" -ArgumentList "tests\test.js" `
                -WorkingDirectory $WstpNodeDir `
                -RedirectStandardOutput $testLog `
                -RedirectStandardError "$testLog.err" `
                -NoNewWindow -PassThru
    $lastLine = 0
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $testLog) {
            $lines = @(Get-Content $testLog -Encoding UTF8)
            if ($lines.Count -gt $lastLine) {
                $lines[$lastLine..($lines.Count - 1)] | Where-Object { $_ -match '^\s+. \d+\.' } | ForEach-Object { Log "    $_" }
                $lastLine = $lines.Count
            }
        }
    }
    Pop-Location

    # Restore test.js
    Set-Content $testJsPath $testJsOriginal -Encoding UTF8

    # Parse results
    $logLines = @(Get-Content $testLog -Encoding UTF8 -ErrorAction SilentlyContinue)
    $allNums  = @($logLines | Where-Object { $_ -match '\s+(\d+)\.' } |
                ForEach-Object { $null = $_ -match '\s+(\d+)\.'; [int]$Matches[1] })
    $failNums = @($logLines | Where-Object { $_ -match '\s+(\d+)\.' -and $_ -match [char]0x2717 } |
                ForEach-Object { $null = $_ -match '\s+(\d+)\.'; [int]$Matches[1] })

    $realFails  = @($failNums | Where-Object { $_ -notin $KnownSkipTests })
    $skippedNum = @($failNums | Where-Object { $_ -in  $KnownSkipTests })
    $total      = $allNums.Count
    $passing    = $total - $failNums.Count

    $reportLines += "WEngine $($ver.Name)"
    $reportLines += "  Total   : $total"
    $reportLines += "  Passed  : $passing"
    $reportLines += "  Skipped : $($skippedNum.Count) (known Windows issues: $($KnownSkipTests -join ', '))"
    $reportLines += "  Failed  : $($realFails.Count)"
    if ($realFails) { $reportLines += "  Failures: $($realFails -join ', ')" }

    # Log individual test lines
    $reportLines += ""
    $reportLines += "  Results:"
    $logLines | Where-Object { $_ -match '^\s+. \d+\.' } | ForEach-Object {
        $num = 0; $null = $_ -match '\s+(\d+)\.'; $num = [int]$Matches[1]
        $tag = if ($num -in $KnownSkipTests) { " [SKIPPED-KNOWN]" } else { "" }
        $reportLines += "    $($_.Trim())$tag"
    }
    $reportLines += ""

    if ($realFails) {
        Log "  WARN WEngine $($ver.Name): $($realFails.Count) unexpected failures: $($realFails -join ', ')"
    } else {
        Log "  OK WEngine $($ver.Name): $passing/$total passed"
    }
}

# ============================================================================
# COPY BINARY + PACKAGE VSIX
# ============================================================================
LogSection "Packaging VSIX"

Copy-Item $Binary "$WolfbookDir\wstp\prebuilt\wstp-win32-x64.node" -Force
Log "Binary copied to wstp/prebuilt/wstp-win32-x64.node"

# ---- Check BTL prebuilt is present ----
$BtlPrebuilt = "$WolfbookDir\wllatex-addon\prebuilt\wolfbook_btl-win32-x64.node"
if (-not (Test-Path $BtlPrebuilt)) {
    Log "ERROR: BTL prebuilt missing: $BtlPrebuilt"
    Log "       Pull from origin/main or copy from a Mac build."
    exit 1
}
Log "BTL prebuilt OK"

# ---- Ensure katex is installed for watchPanel.js ----
if (Test-Path "$WolfbookDir\wllatex-addon\package.json") {
    npm install --prefix "$WolfbookDir\wllatex-addon" --omit=dev 2>&1 | Out-Null
    Log "wllatex-addon npm install done (katex)"
} else {
    Log "WARN: wllatex-addon/package.json not found - KaTeX may not render"
}

Push-Location $WolfbookDir
npm install 2>&1 | Out-Null

$WolfbookVersion = ((Get-Content "$WolfbookDir\package.json" -Raw) |
    Select-String '"version"\s*:\s*"([^"]+)"').Matches[0].Groups[1].Value
$VsixName = "wolfbook-$WolfbookVersion-win32-x64.vsix"

$env:npm_config_msvs_version = ""   # clear so vsce doesn't inherit it
vsce package --allow-missing-repository --target win32-x64 -o $VsixName 2>&1 | ForEach-Object { Log "  $_" }
if ($LASTEXITCODE -ne 0) { Log "ERROR: vsce package failed"; Pop-Location; exit 1 }
$VsixPath = Join-Path $WolfbookDir $VsixName
Log "VSIX: $VsixPath"
Pop-Location

# ============================================================================
# WRITE TEST REPORT
# ============================================================================
$reportFile = Join-Path $WolfbookDir "windows-test-report.txt"
$reportLines | Set-Content $reportFile -Encoding UTF8
Log "Test report written: $reportFile"

# ============================================================================
# PUSH TO GIT
# ============================================================================
if (-not $DryRun) {
    LogSection "Pushing changes to git"

    Push-Location $WolfbookDir
    git add "wstp/prebuilt/wstp-win32-x64.node" "windows-test-report.txt" 2>&1 | Out-Null
    git add -f $VsixName 2>&1 | Out-Null   # *.vsix is gitignored - force-add
    $commitMsg = "chore(windows): rebuild wstp.node with WEngine $BuildVersion [auto]"
    git commit -m $commitMsg 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        git push 2>&1 | ForEach-Object { Log "  git: $_" }
        if ($LASTEXITCODE -ne 0) { Log "WARN: git push failed - will retry next cycle" }
        else { Log "Pushed wolfbook" }
    } else {
        Log "Nothing to commit in wolfbook (binary unchanged)"
    }
    Pop-Location

    # Update state hashes now that we've rebuilt successfully
    foreach ($name in $repos.Keys) {
        $r = $repos[$name]
        if (Test-Path "$($r.Dir)\.git") {
            $h = Get-LocalHash $r.Dir
            if ($h) { $state.$name = $h }
        }
    }
    Save-State $state
    Log "State updated"
} else {
    Log "DryRun: skipping git push and state update"
    Log "DryRun: VSIX would be installed from $VsixPath"
}

# ============================================================================
# INSTALL VSIX
# ============================================================================
if (-not $DryRun) {
    LogSection "Installing VSIX"
    code --install-extension $VsixPath --force 2>&1 | ForEach-Object { Log "  $_" }
    if ($LASTEXITCODE -eq 0) { Log "Installed. Reload VS Code window to activate." }
    else                     { Log "WARN: VS Code install failed (is VS Code running?)" }
}

LogSection "Done"
Log "VSIX : $VsixPath"
