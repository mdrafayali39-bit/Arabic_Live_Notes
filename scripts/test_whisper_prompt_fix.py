import sys
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

# Let's inspect tokenizer tokens for the bad prompts
tokenizer = whisper.tokenizer.get_tokenizer(model.is_multilingual, language="en", task="translate")
bad_english_prompt = "Welcome to the lecture. Today we will explain the lesson in English."
prompt_tokens = tokenizer.encode(" " + bad_english_prompt.strip())
print(f"\nBad English prompt tokens count: {len(prompt_tokens)}")
print(f"Decoded prompt tokens: '{tokenizer.decode(prompt_tokens)}'")

arabic_tokenizer = whisper.tokenizer.get_tokenizer(model.is_multilingual, language="ar", task="transcribe")
bad_arabic_prompt = "بسم الله الرحمن الرحيم، مرحبا بكم في هذه المحاضرة. سنشرح اليوم الدرس باللغة العربية الفصحى."
ar_prompt_tokens = arabic_tokenizer.encode(" " + bad_arabic_prompt.strip())
print(f"Bad Arabic prompt tokens count: {len(ar_prompt_tokens)}")
print(f"Decoded Arabic prompt tokens: '{arabic_tokenizer.decode(ar_prompt_tokens)}'")

print("\n--- CONCLUSION ---")
print("When these prompt tokens are passed as initial_prompt, Whisper autoregressively generates continuations of these exact strings (e.g. 'The lesson in English.', 'Good bye.', 'What about?') instead of translating the actual input audio.")
