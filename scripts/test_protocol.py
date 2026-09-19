"""
Exercises the speech engine's wire protocol without loading a real model.

    python scripts/test_protocol.py

Torch and Whisper are replaced with stand-ins that echo back a canned result,
so this checks the framing, the two channels, the second pass that produces the
original-language text, and the filter that drops Whisper's silence
hallucinations. It needs only numpy and websockets.
"""

from __future__ import annotations

import asyncio
import json
import struct
import sys
import types
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

# --------------------------------------------------------------------------
# Stand-ins, installed before asr_server imports them
# --------------------------------------------------------------------------

torch_stub = types.ModuleType("torch")
torch_stub.cuda = types.SimpleNamespace(is_available=lambda: False)
sys.modules["torch"] = torch_stub


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append({"task": kwargs.get("task"), "samples": len(audio)})
        if kwargs.get("task") == "translate":
            return {"text": "  The server rack is overheating.  ", "language": "ar"}
        return {"text": "خزانة الخادم ترتفع حرارتها", "language": "ar"}


FAKE = FakeModel()

whisper_stub = types.ModuleType("whisper")
whisper_stub.load_model = lambda *a, **k: FAKE
whisper_stub.Whisper = FakeModel
sys.modules["whisper"] = whisper_stub

import asr_server  # noqa: E402

import websockets  # noqa: E402

PASS, FAIL = [], []


def check(label, condition, detail=""):
    (PASS if condition else FAIL).append(label)
    mark = "  ok  " if condition else " FAIL "
    print(f"[{mark}] {label}" + (f"  ({detail})" if detail else ""))


def frame(header: dict, seconds: float = 2.0) -> bytes:
    """Build a client frame the way the renderer does."""
    samples = (np.sin(np.arange(int(16000 * seconds)) * 0.05) * 0.4 * 32767).astype("<i2")
    head = json.dumps(header).encode("utf-8")
    return struct.pack("<I", len(head)) + head + samples.tobytes()


# --------------------------------------------------------------------------
# Unit-level checks
# --------------------------------------------------------------------------

def unit_checks():
    pcm = np.array([0, 16384, -16384, 32767], dtype="<i2").tobytes()
    out = asr_server.pcm16_to_float32(pcm)
    check("PCM converts to float in [-1, 1]",
          out.dtype == np.float32 and abs(out[1] - 0.5) < 1e-4 and abs(out[2] + 0.5) < 1e-4,
          f"{out.round(3).tolist()}")

    # Empty and whitespace
    check("empty strings are dropped",
          asr_server.looks_like_noise("  ") and asr_server.looks_like_noise("!!!"))

    # Decode loops are dropped
    check("decode loops are dropped",
          asr_server.looks_like_noise("yes yes yes yes yes yes yes")
          and asr_server.looks_like_noise("hello world hello world hello world hello world"))

    # Real sentences and Arabic classroom/religious phrases SURVIVE
    check("real sentences survive",
          not asr_server.looks_like_noise("The server rack is overheating."))

    check("legitimate Arabic classroom phrases survive without blacklisting",
          not asr_server.looks_like_noise("الحمد لله رب العالمين")
          and not asr_server.looks_like_noise("شكرا جزيلا لكم")
          and not asr_server.looks_like_noise("نعم هذا صحيح")
          and not asr_server.looks_like_noise("بسم الله الرحمن الرحيم"))

    # Near-silent synthetic subtitle hallucinations dropped when audio is silent
    silent_audio = np.zeros(16000, dtype=np.float32)
    check("synthetic subtitle tags dropped when audio is dead silent",
          asr_server.looks_like_noise("subtitles by the amara.org community", silent_audio))


# --------------------------------------------------------------------------
# Live socket round trip
# --------------------------------------------------------------------------

async def socket_checks():
    engine = asr_server.Engine("small", ROOT / "models", "cpu")
    engine.load()

    async def handler(ws):
        await asr_server.Session(engine, ws).pump()

    async with websockets.serve(handler, "127.0.0.1", 0, max_size=64 * 1024 * 1024) as server:
        port = server.sockets[0].getsockname()[1]

        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            hello = json.loads(await ws.recv())
            check("engine announces itself on connect",
                  hello["type"] == "ready" and hello["model"] == "small",
                  f"device={hello['device']}")

            # --- speaker channel, Arabic in / English out, with source pass ---
            await ws.send(frame({
                "id": "speaker-1", "channel": "speaker",
                "task": "translate", "language": "ar", "source": True,
            }))

            first = json.loads(await ws.recv())
            check("a placeholder is sent before the work starts",
                  first["type"] == "partial" and first["id"] == "speaker-1")

            result = json.loads(await ws.recv())
            check("English text comes back on the speaker channel",
                  result["type"] == "result"
                  and result["channel"] == "speaker"
                  and result["text"] == "The server rack is overheating.",
                  result["text"])
            check("the original Arabic comes back too",
                  result["source"] == "خزانة الخادم ترتفع حرارتها", result["source"])
            check("audio length survives the round trip",
                  abs(result["seconds"] - 2.0) < 0.05, f"{result['seconds']}s")
            check("latency instrumentation timestamps are included",
                  "t_asr_finalized" in result and "asr_latency_ms" in result)

            # --- dictation channel ---
            await ws.send(frame({
                "id": "mine-1", "channel": "mine",
                "task": "translate", "language": "ar", "source": False,
            }))
            await ws.recv()  # partial
            mine = json.loads(await ws.recv())
            check("the dictation channel is answered separately",
                  mine["channel"] == "mine" and mine["text"], mine["text"])
            check("no second pass when the source is not wanted",
                  mine["source"] == "")

            # --- too short to be speech (< 120ms) ---
            await ws.send(frame({"id": "tiny", "channel": "speaker",
                                 "task": "translate", "language": "ar"}, seconds=0.08))
            tiny = json.loads(await ws.recv())
            check("clips under 120 ms are rejected without decoding",
                  tiny["type"] == "result" and tiny["noSpeech"] and tiny["text"] == "")

            # --- control frame ---
            await ws.send(json.dumps({"type": "ping"}))
            pong = json.loads(await ws.recv())
            check("the keep-alive works", pong["type"] == "pong")

    tasks = [c["task"] for c in FAKE.calls]
    check("Whisper performs Arabic transcription before translation",
          tasks == ["transcribe", "translate", "transcribe", "translate"], str(tasks))


def main():
    unit_checks()
    asyncio.run(socket_checks())
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed.")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
