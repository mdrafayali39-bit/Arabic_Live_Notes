# Arabic Live Notes - one-time setup for Windows.
#
#   Right-click this file and choose "Run with PowerShell",
#   or from a terminal in the project folder:
#
#       powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# Options:
#       -Gpu              install the CUDA build of PyTorch (NVIDIA cards)
#       -Model small      which Whisper model to fetch now (default: small)
#       -SkipModel        don't download a model yet

param(
    [switch]$Gpu,
    [string]$Model = "small",
    [switch]$SkipModel
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($text) { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "   $text" -ForegroundColor DarkGray }

# --------------------------------------------------------------------------
Step "Checking what is already installed"

$python = $null
foreach ($candidate in @("py -3.12", "py -3.11", "py -3.13", "python", "python3")) {
    try {
        $parts = $candidate.Split(" ")
        $version = & $parts[0] $parts[1..($parts.Length - 1)] --version 2>&1
        if ($version -match "Python 3\.(9|10|11|12|13)\b") { $python = $candidate; break }
    } catch { }
}

if (-not $python) {
    Write-Host @"

Python 3.9 to 3.13 was not found.

Install it from https://www.python.org/downloads/ and tick
"Add python.exe to PATH" during setup, then run this script again.

PyTorch publishes builds for 3.9 through 3.13.
"@ -ForegroundColor Yellow
    exit 1
}
Note "Python: $python"

try { $nodeVersion = node --version } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
    Write-Host @"

Node.js was not found. Install the LTS build from https://nodejs.org
and run this script again.
"@ -ForegroundColor Yellow
    exit 1
}
Note "Node: $nodeVersion"

# --------------------------------------------------------------------------
Step "Creating the Python environment"

$venv = Join-Path $Root "python\.venv"
if (-not (Test-Path $venv)) {
    $parts = $python.Split(" ")
    & $parts[0] $parts[1..($parts.Length - 1)] -m venv $venv
}
$vpy = Join-Path $venv "Scripts\python.exe"
& $vpy -m pip install --upgrade pip --quiet

# --------------------------------------------------------------------------
Step "Installing PyTorch (this is the big one, around 250 MB to 2.5 GB)"

if ($Gpu) {
    Note "CUDA build, for NVIDIA graphics cards"
    & $vpy -m pip install torch --index-url https://download.pytorch.org/whl/cu126
} else {
    Note "CPU build. Re-run with -Gpu if you have an NVIDIA card."
    & $vpy -m pip install torch --index-url https://download.pytorch.org/whl/cpu
}

Step "Installing the rest of the Python packages"
& $vpy -m pip install -r (Join-Path $Root "python\requirements.txt")

# --------------------------------------------------------------------------
Step "Installing Electron"
npm install

# --------------------------------------------------------------------------
if (-not $SkipModel) {
    Step "Fetching the '$Model' speech model"
    Note "It lands in the models folder and is never downloaded again."
    $script = @"
import sys
sys.path.insert(0, r'$Root\python\vendor\whisper-src')
import whisper
whisper.load_model('$Model', device='cpu', download_root=r'$Root\models')
print('model ready')
"@
    & $vpy -c $script
}

# --------------------------------------------------------------------------
Write-Host @"

Setup finished.

Start the app with:

    npm start

"@ -ForegroundColor Green
