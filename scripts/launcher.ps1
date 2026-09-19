# Arabic Live Notes - launcher.
#
# Started by "Arabic Live Notes.bat". On the first run it installs everything
# the app needs and makes a desktop shortcut. On every run after that it checks
# in well under a second and opens the window.

param([switch]$Reinstall, [switch]$NoLaunch)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Stamp   = Join-Path $Root ".installed"
$Version = "2"           # bump to force an install check after an update
$Venv    = Join-Path $Root "python\.venv"
$VPy     = Join-Path $Venv "Scripts\python.exe"

$Host.UI.RawUI.WindowTitle = "Arabic Live Notes"

function Say  ($t) { Write-Host $t -ForegroundColor Gray }
function Head ($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Good ($t) { Write-Host $t -ForegroundColor Green }
function Warn ($t) { Write-Host $t -ForegroundColor Yellow }

function Fail ($title, $body, $url) {
    Write-Host "`n  $title`n" -ForegroundColor Red
    Write-Host $body
    if ($url) {
        Write-Host "`n  $url`n" -ForegroundColor Cyan
        $open = Read-Host "  Open that page now? (y/n)"
        if ($open -eq "y") { Start-Process $url }
    }
    Write-Host ""
    Read-Host "  Press Enter to close"
    exit 1
}

# --------------------------------------------------------------------------
# Fast path: everything was installed already
# --------------------------------------------------------------------------

$needsInstall = $true
if ((Test-Path $Stamp) -and -not $Reinstall) {
    if ((Get-Content $Stamp -Raw).Trim() -eq $Version -and
        (Test-Path $VPy) -and
        (Test-Path (Join-Path $Root "node_modules\electron\dist\electron.exe"))) {
        $needsInstall = $false
    }
}

# --------------------------------------------------------------------------
# First run
# --------------------------------------------------------------------------

if ($needsInstall) {

    Write-Host @"

  Arabic Live Notes
  Setting up. This happens once and takes a while - most of it is
  downloading PyTorch and the speech model. Leave it running.

"@ -ForegroundColor Cyan

    # ---- Python -----------------------------------------------------------
    Head "Looking for Python"
    $python = $null
    foreach ($c in @("py -3.12", "py -3.11", "py -3.13", "py -3.10", "python", "python3")) {
        try {
            $p = $c.Split(" ")
            $v = & $p[0] $p[1..($p.Length - 1)] --version 2>&1
            if ($v -match "Python 3\.(9|10|11|12|13)\b") { $python = $c; Say "  found $v"; break }
        } catch { }
    }
    if (-not $python) {
        Fail "Python is not installed" @"
  This app needs Python 3.9 or newer to run the speech engine.

  On the download page, choose the Windows installer, and make sure you
  tick "Add python.exe to PATH" on the very first screen. That tick box
  is the step people miss.

  Install it, then double-click "Arabic Live Notes" again.
"@ "https://www.python.org/downloads/"
    }

    # ---- Node -------------------------------------------------------------
    Head "Looking for Node.js"
    $node = $null
    try { $node = node --version 2>&1 } catch { }
    if (-not $node -or $node -notmatch "^v\d") {
        Fail "Node.js is not installed" @"
  This app needs Node.js to draw its window.

  Download the LTS version, run the installer, accept the defaults,
  then double-click "Arabic Live Notes" again.
"@ "https://nodejs.org/en/download"
    }
    Say "  found Node $node"

    # ---- Graphics card ----------------------------------------------------
    Head "Looking for an NVIDIA graphics card"
    $gpu = $null
    try {
        $gpu = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>&1 | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { $gpu = $null }
    } catch { }
    if ($gpu) { Good "  found $gpu - the fast build will be installed" }
    else { Say "  none found, the app will run on the processor" }

    # ---- Environment ------------------------------------------------------
    Head "Creating the Python environment"
    if (-not (Test-Path $VPy)) {
        $p = $python.Split(" ")
        & $p[0] $p[1..($p.Length - 1)] -m venv $Venv
    }
    & $VPy -m pip install --upgrade pip --quiet

    # ---- PyTorch ----------------------------------------------------------
    Head "Installing PyTorch"
    Say "  This is the big download. Several minutes on a normal connection."
    $installed = $false
    if ($gpu) {
        # CUDA 12.6 has the widest driver compatibility of the current builds
        # and covers every RTX 30, 40 and 50 series card.
        foreach ($idx in @("cu126", "cu128")) {
            Say "  trying the $idx build"
            & $VPy -m pip install torch --index-url "https://download.pytorch.org/whl/$idx"
            if ($LASTEXITCODE -eq 0) { $installed = $true; break }
            Warn "  $idx did not work, trying the next one"
        }
    }
    if (-not $installed) {
        if ($gpu) { Warn "  falling back to the processor build" }
        & $VPy -m pip install torch --index-url "https://download.pytorch.org/whl/cpu"
        if ($LASTEXITCODE -ne 0) {
            Fail "PyTorch could not be installed" @"
  The download failed. This is almost always a network problem - a
  company firewall or a proxy blocking download.pytorch.org.

  Try again on a different connection, then double-click
  "Arabic Live Notes" once more.
"@ $null
        }
    }

    Head "Installing the rest of the Python packages"
    & $VPy -m pip install -r (Join-Path $Root "python\requirements.txt")
    if ($LASTEXITCODE -ne 0) { Fail "A Python package failed to install" "  Check the messages above." $null }

    # ---- Electron ---------------------------------------------------------
    Head "Installing the window"
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "Electron could not be installed" "  Check the messages above." $null }

    # ---- Model ------------------------------------------------------------
    $models = Join-Path $Root "models"
    if (-not (Get-ChildItem $models -Filter *.pt -ErrorAction SilentlyContinue)) {
        # With a GPU, large-v3 is the accurate one and fits comfortably in
        # 6 GB at half precision. Without one it would be unusably slow.
        $model = if ($gpu) { "large-v3" } else { "small" }
        Head "Downloading the '$model' speech model"
        Say "  One-time download. Around $(if ($gpu) {'3 GB'} else {'0.5 GB'})."
        $code = @"
import sys
sys.path.insert(0, r'$Root\python\vendor\whisper-src')
import whisper
whisper.load_model('$model', device='cpu', download_root=r'$models')
print('done')
"@
        & $VPy -c $code
        if ($LASTEXITCODE -ne 0) { Warn "  The model download failed. The app will retry when you press start." }
        else {
            # Make it the default so the first launch is already correct.
            $cfgDir = Join-Path $env:APPDATA "arabic-live-notes"
            New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
            $cfg = Join-Path $cfgDir "settings.json"
            if (-not (Test-Path $cfg)) {
                '{ "model": "' + $model + '" }' | Set-Content $cfg -Encoding UTF8
            }
        }
    }

    # ---- Shortcuts --------------------------------------------------------
    Head "Making a shortcut"
    try { & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "make-shortcut.ps1") }
    catch { Warn "  Could not make the shortcut. Start the app from this folder instead." }

    $Version | Set-Content $Stamp -Encoding ASCII

    Write-Host @"

  Ready.

  There is now an "Arabic Live Notes" icon on your desktop.
  Double-click it any time to open the app.

"@ -ForegroundColor Green
    Start-Sleep -Seconds 3
}

# --------------------------------------------------------------------------
# Launch
# --------------------------------------------------------------------------

if ($NoLaunch) { exit 0 }

$electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) {
    Fail "The app is not installed properly" @"
  Electron is missing. Run this again with a reinstall:

      powershell -ExecutionPolicy Bypass -File scripts\launcher.ps1 -Reinstall
"@ $null
}

Start-Process -FilePath $electron -ArgumentList "`"$Root`"" -WorkingDirectory $Root
