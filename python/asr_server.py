"""
Speech engine for Arabic Live Notes.

Runs as a child process of the Electron app and speaks a small binary
WebSocket protocol. The renderer captures microphone / system audio, cuts it
into utterances, and ships raw 16 kHz mono PCM here. Nothing touches the disk
and ffmpeg is never invoked -- Whisper's transcribe() accepts a float32 numpy
array directly, which is what we hand it.

Wire format, client -> server (binary frame):
    [uint32 LE headerLength][header JSON utf-8][int16 LE PCM @ 16 kHz mono]

Header fields:
    id       str    caller-chosen utterance id, echoed back
    channel  str    "speaker" (Arabic in, English out) or "mine" (dictation)
    task     str    "translate" or "transcribe"
    language str    source language hint, or "auto"
    source   bool   also run a second pass to get the original-language text

Server -> client (text frames, one JSON object per frame):
    {"type":"ready",    "device":..., "model":..., "fp16":...}
    {"type":"loading",  "model":...}
    {"type":"partial",  "id":..., "channel":...}          queued, work started
    {"type":"result",   "id":..., "channel":..., "text":..., "source":...,
     "seconds":..., "elapsed":..., "noSpeech":...}
    {"type":"error",    "message":...}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent

# Prefer the copy of Whisper shipped inside this app over anything the user
# may already have installed, so behaviour is identical on every machine.
sys.path.insert(0, str(HERE / "vendor" / "whisper-src"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
import websockets  # noqa: E402

import whisper  # noqa: E402

SAMPLE_RATE = 16000

# large-v3-turbo was distilled on transcription data only; its X->English
# translation is noticeably worse than large-v3. We let people pick it, but the
# UI warns them and we log it here too.
WEAK_AT_TRANSLATION = {"turbo", "large-v3-turbo"}


def log(*parts: Any) -> None:
    """Diagnostics go to stderr; stdout is reserved for the handshake line."""
    print(*parts, file=sys.stderr, flush=True)


class Engine:
    """Owns the Whisper model and serialises every decode onto one thread."""

    def __init__(self, model_name: str, models_dir: Path, device: Optional[str]):
        self.model_name = model_name
        self.models_dir = models_dir
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.fp16 = self.device == "cuda"
        self.model: Optional[whisper.Whisper] = None
        # One worker: torch models are not safe to call concurrently, and
        # queuing keeps latency predictable instead of thrashing the CPU.
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
        self.lock = asyncio.Lock()

    def load(self) -> None:
        self.models_dir.mkdir(parents=True, exist_ok=True)
        log(f"[engine] loading {self.model_name} on {self.device} "
            f"(weights dir: {self.models_dir})")
        started = time.time()
        self.model = whisper.load_model(
            self.model_name,
            device=self.device,
            download_root=str(self.models_dir),
        )
        log(f"[engine] ready in {time.time() - started:.1f}s")
        if self.model_name in WEAK_AT_TRANSLATION:
            log("[engine] warning: this model is weak at translating into "
                "English. Use 'small', 'medium' or 'large-v3' for Arabic.")

    def _decode(
        self,
        audio: np.ndarray,
        task: str,
        language: Optional[str],
        prompt: Optional[str],
    ) -> dict:
        assert self.model is not None
        # Full temperature fallback schedule allows Whisper to escape repetitive loops
        return self.model.transcribe(
            audio,
            task=task,
            language=language,
            fp16=self.fp16,
            beam_size=5,
            best_of=5,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            logprob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            initial_prompt=prompt or None,
            verbose=None,
        )

    async def run(
        self,
        audio: np.ndarray,
        task: str,
        language: Optional[str],
        prompt: Optional[str],
    ) -> dict:
        loop = asyncio.get_running_loop()
        async with self.lock:
            return await loop.run_in_executor(
                self.pool, self._decode, audio, task, language, prompt
            )


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    """int16 little-endian bytes -> float32 in [-1, 1], which is what Whisper wants."""
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    return samples / 32768.0


if sys.platform == "win32":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def clean(text: str) -> str:
    return " ".join(text.split()).strip()


def looks_like_noise(text: str, audio: Optional[np.ndarray] = None) -> bool:
    """
    Contextual and acoustic noise filter.
    Replaces static phrase blacklists with structural heuristics:
    1. Checks for empty / whitespace-only output.
    2. Detects decode loops (repetitive token / n-gram cycles).
    3. Checks YouTube subtitle artifacts only when audio is near-silent.
    Legitimate classroom speech and religious phrases (e.g. 'الحمد لله رب العالمين')
    are NEVER discarded.
    """
    stripped = text.strip()
    if not stripped:
        return True

    # Strip punctuation to check tokens
    normalized = stripped.lower().rstrip("!.،?,:;")
    if not normalized:
        return True

    # Decode loop check: repeated identical tokens or multi-word phrase cycles filling the window
    words = normalized.split()
    if len(words) >= 6:
        unique_words = set(words)
        if len(unique_words) <= 2:
            return True
        # Check for repeated 2-word, 3-word, 4-word, or 5-word phrase cycles (e.g. "he is god a he is god a he is god a")
        for k in (2, 3, 4, 5):
            if len(words) >= k * 3:
                ngrams = [tuple(words[i : i + k]) for i in range(len(words) - k + 1)]
                for i in range(len(ngrams) - 2):
                    if ngrams[i] == ngrams[i + 1] == ngrams[i + 2]:
                        return True

    # Check for known synthetic subtitle artifacts ONLY if audio energy is essentially dead silence
    if audio is not None and len(audio) > 0:
        max_amp = float(np.max(np.abs(audio)))
        if max_amp < 0.005:
            # Under near-zero amplitude, subtitle credits are hallucinations
            synthetic_markers = {
                "subtitles by the amara.org community",
                "subtitles by",
                "ترجمة نانسي قنقر",
            }
            if normalized in synthetic_markers:
                return True

    return False


class Session:
    def __init__(self, engine: Engine, ws):
        self.engine = engine
        self.ws = ws

    async def send(self, payload: dict) -> None:
        try:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        except websockets.ConnectionClosed:
            pass

    async def handle_frame(self, frame: bytes) -> None:
        if len(frame) < 4:
            return
        (header_len,) = struct.unpack("<I", frame[:4])
        header = json.loads(frame[4 : 4 + header_len].decode("utf-8"))
        audio = pcm16_to_float32(frame[4 + header_len :])

        utt_id = header.get("id", "")
        channel = header.get("channel", "speaker")
        task = header.get("task", "translate")
        language = header.get("language") or None
        if language in ("auto", "", None):
            language = None
        want_source = bool(header.get("source"))
        prompt = header.get("prompt") or None
        t_capture_start = header.get("t_capture_start")
        t_vad_accepted = header.get("t_vad_accepted")

        # Explicit language: For Arabic classroom or dictation, ensure 'ar' is explicitly passed
        asr_lang = language or "ar"

        seconds = len(audio) / SAMPLE_RATE
        # Lowered cutoff to 0.12s so short words like 'نعم' or 'لا' are preserved
        if seconds < 0.12:
            await self.send({
                "type": "result",
                "id": utt_id,
                "channel": channel,
                "text": "",
                "source": "",
                "seconds": round(seconds, 3),
                "noSpeech": True,
                "t_capture_start": t_capture_start,
                "t_vad_accepted": t_vad_accepted,
                "t_asr_finalized": time.time() * 1000,
                "model": self.engine.model_name,
                "device": self.engine.device,
            })
            return

        t_asr_start = time.time() * 1000
        await self.send({
            "type": "partial",
            "id": utt_id,
            "channel": channel,
            "t_asr_start": t_asr_start,
        })
        started = time.time()

        try:
            # PASS 1: ALWAYS perform high-accuracy Arabic speech transcription first
            # The Arabic source text is the immutable source of truth.
            transcribe_res = await self.engine.run(audio, "transcribe", asr_lang, prompt)
            source_text = clean(transcribe_res.get("text", ""))
            detected = transcribe_res.get("language") or asr_lang
            is_no_speech = looks_like_noise(source_text, audio)

            translated_text = ""
            if not is_no_speech and source_text and task == "translate":
                # PASS 2: Translate to English only AFTER Arabic source text is established
                # No static prompt prefix so Whisper never hallucinates canned English phrases
                trans_res = await self.engine.run(audio, "translate", asr_lang, None)
                translated_text = clean(trans_res.get("text", ""))
                if looks_like_noise(translated_text, audio) or not translated_text:
                    translated_text = source_text
            elif not is_no_speech:
                translated_text = source_text

            t_asr_finalized = time.time() * 1000
            asr_latency_ms = round(t_asr_finalized - t_asr_start, 2)
            elapsed = round(time.time() - started, 2)

            log(
                f"[ASR] id={utt_id} chan={channel} req_lang={language} "
                f"actual_lang={asr_lang} task={task} model={self.engine.model_name} "
                f"device={self.engine.device} dur={seconds:.2f}s elapsed={elapsed:.2f}s "
                f"source='{source_text}' text='{translated_text}'"
            )

            source_payload = "" if is_no_speech else (
                source_text if (want_source or task == "transcribe" or channel == "speaker") else ""
            )

            await self.send({
                "type": "result",
                "id": utt_id,
                "channel": channel,
                "text": "" if is_no_speech else (translated_text if task == "translate" else source_text),
                "source": source_payload,
                "language": detected or asr_lang,
                "seconds": round(seconds, 2),
                "elapsed": elapsed,
                "noSpeech": is_no_speech,
                "t_capture_start": t_capture_start,
                "t_vad_accepted": t_vad_accepted,
                "t_asr_start": t_asr_start,
                "t_asr_finalized": t_asr_finalized,
                "asr_latency_ms": asr_latency_ms,
                "model": self.engine.model_name,
                "device": self.engine.device,
            })
        except Exception as exc:  # noqa: BLE001
            log("[engine] decode failed:", traceback.format_exc())
            t_asr_finalized = time.time() * 1000
            await self.send({
                "type": "error",
                "id": utt_id,
                "channel": channel,
                "message": f"Could not transcribe that segment: {exc}",
                "t_capture_start": t_capture_start,
                "t_vad_accepted": t_vad_accepted,
                "t_asr_finalized": t_asr_finalized,
                "model": self.engine.model_name,
                "device": self.engine.device,
            })

    async def pump(self) -> None:
        await self.send({
            "type": "ready",
            "model": self.engine.model_name,
            "device": self.engine.device,
            "fp16": self.engine.fp16,
            "weakAtTranslation": self.engine.model_name in WEAK_AT_TRANSLATION,
        })
        async for message in self.ws:
            if isinstance(message, bytes):
                await self.handle_frame(message)
            else:
                # Text frames are reserved for control; "ping" keeps the socket
                # warm while nobody is speaking.
                try:
                    control = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if control.get("type") == "ping":
                    await self.send({"type": "pong"})


async def main_async(args: argparse.Namespace) -> None:
    engine = Engine(args.model, Path(args.models_dir), args.device)

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, engine.load)

    async def handler(ws):
        await Session(engine, ws).pump()

    async with websockets.serve(
        handler, "127.0.0.1", args.port, max_size=64 * 1024 * 1024
    ) as server:
        port = server.sockets[0].getsockname()[1]
        # The single line Electron waits for before showing the window.
        print(json.dumps({"event": "listening", "port": port}), flush=True)
        log(f"[engine] listening on 127.0.0.1:{port}")
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser(description="Arabic Live Notes speech engine")
    parser.add_argument("--model", default=os.environ.get("ALN_MODEL", "small"))
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument(
        "--models-dir",
        default=os.environ.get("ALN_MODELS_DIR", str(HERE.parent / "models")),
    )
    parser.add_argument("--device", default=os.environ.get("ALN_DEVICE") or None)
    args = parser.parse_args()

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
