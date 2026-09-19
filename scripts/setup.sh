#!/usr/bin/env bash
# Arabic Live Notes - one-time setup for macOS and Linux.
#
#   bash scripts/setup.sh              CPU build of PyTorch
#   bash scripts/setup.sh --gpu        CUDA build (Linux, NVIDIA card)
#   bash scripts/setup.sh --model medium
#   bash scripts/setup.sh --skip-model

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GPU=0
MODEL="small"
SKIP_MODEL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gpu) GPU=1; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    --skip-model) SKIP_MODEL=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

step() { printf "\n\033[36m>> %s\033[0m\n" "$1"; }
note() { printf "   \033[90m%s\033[0m\n" "$1"; }

step "Checking what is already installed"

PYTHON=""
for candidate in python3.12 python3.11 python3.13 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if (3,9) <= sys.version_info < (3,14) else 1)'; then
      PYTHON="$candidate"; break
    fi
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "Python 3.9 to 3.13 was not found." >&2
  exit 1
fi
note "Python: $PYTHON ($($PYTHON --version))"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install the LTS build from https://nodejs.org" >&2
  exit 1
fi
note "Node: $(node --version)"

step "Creating the Python environment"
[[ -d python/.venv ]] || "$PYTHON" -m venv python/.venv
VPY="$ROOT/python/.venv/bin/python"
"$VPY" -m pip install --upgrade pip --quiet

step "Installing PyTorch (this is the big one)"
if [[ "$GPU" == "1" ]]; then
  note "CUDA build"
  "$VPY" -m pip install torch --index-url https://download.pytorch.org/whl/cu126
elif [[ "$(uname -s)" == "Darwin" ]]; then
  note "Apple build, with Metal support"
  "$VPY" -m pip install torch
else
  note "CPU build. Pass --gpu if you have an NVIDIA card."
  "$VPY" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
fi

step "Installing the rest of the Python packages"
"$VPY" -m pip install -r python/requirements.txt

step "Installing Electron"
npm install

if [[ "$SKIP_MODEL" == "0" ]]; then
  step "Fetching the '$MODEL' speech model"
  note "It lands in the models folder and is never downloaded again."
  "$VPY" - <<PY
import sys
sys.path.insert(0, "$ROOT/python/vendor/whisper-src")
import whisper
whisper.load_model("$MODEL", device="cpu", download_root="$ROOT/models")
print("model ready")
PY
fi

printf "\n\033[32mSetup finished. Start the app with:\n\n    npm start\n\033[0m\n"
