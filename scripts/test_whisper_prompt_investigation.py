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
print(f"Loading Whisper model on {device}...")
model = whisper.load_model("small", download_root=str(MODELS_DIR), device=device)
print("Model loaded successfully.")

# Investigate prompt engineering vs hallucinations
test_phrases = [
    ("marhaban", "مرحبا بكم"),
    ("bismillah", "بسم الله الرحيم"),
    ("muhadara", "في هذه المحاضرة"),
    ("dars", "سنشرح اليوم الدرس باللغة العربية الفصحى"),
    ("khutba", "خطبة الجمعة وصلاة الجمعة في المسجد الجامع"),
]

print("\n--- Testing Whisper decoding with and without English initial_prompt ---")
