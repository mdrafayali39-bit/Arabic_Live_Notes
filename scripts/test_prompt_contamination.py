import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent / "python"
sys.path.insert(0, str(HERE / "vendor" / "whisper-src"))

import whisper
import numpy as np
import torch

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Loading small model on {device}...")
model = whisper.load_model("small", download_root=str(MODELS_DIR), device=device)
print("Model loaded.")

# Let's inspect Whisper's default decoding options
print("\n--- Whisper default decoding options ---")
default_options = whisper.DecodingOptions()
print("Default task:", default_options.task)
print("Default language:", default_options.language)
print("Default temperature:", default_options.temperature)
print("Default beam_size:", default_options.beam_size)
print("Default prompt:", default_options.prompt)
