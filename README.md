# Arabic Live Notes

For following a class taught in Arabic.

The top half listens to the teacher and writes what they said in English, line
by line, as they say it. Turn on **Read aloud** and it also speaks each line
into your headphones, so you can listen rather than read.

The bottom half is the opposite: you talk, it writes. The text sits in an
editable box with a copy button, ready to paste into a prompt, a document or
another tool.

Everything runs on your own machine. No audio ever leaves the computer.

---

## Starting it

Unzip the folder somewhere permanent — your Documents folder is fine, but do
not run it from inside the zip viewer.

Then **double-click `Arabic Live Notes.bat`**.

The first time, it installs everything and puts an **Arabic Live Notes** icon
on your desktop. That takes a while, mostly downloading. Leave it alone until
it says *Ready*.

After that, double-click the desktop icon. The app opens with no console
window.

If something breaks later, double-click **`Repair.bat`**.

### What it needs first

Two things, and the launcher tells you if either is missing, with the download
link:

- **Python** 3.9 or newer. On the installer's first screen, tick
  **Add python.exe to PATH**. That tick box is the step people miss.
- **Node.js**, the LTS version, default options.

### What it downloads

| Piece | Size |
|---|---|
| PyTorch, CUDA build | ~2.5 GB |
| Electron | ~150 MB |
| `large-v3` speech model | ~3 GB |

These are not in the zip because the right PyTorch build depends on your
graphics card, Electron differs per operating system, and the model is a
trade-off between accuracy and speed. The launcher works all of that out by
running `nvidia-smi`, and picks for you.

There is no ffmpeg in that list. Most Whisper front-ends need it to decode
audio files; this one sends raw samples straight to the model.

### On your machine specifically

You have an **RTX 4050 and an i7**, so the launcher installs the CUDA build and
chooses **`large-v3`**, the most accurate model. At half precision it needs
roughly 3 GB of video memory, which fits your 6 GB comfortably, and it will run
several times faster than real time. That is the right setup for a lecture.

---

## About "100% accurate"

It will not be, and no speech tool is. I would rather say so now than have you
find out during a class.

What you can expect from `large-v3` on clear lecture audio is roughly **90–95%
of words correct**, with meaning that is almost always right even where
individual words are not. What pushes it lower:

- **Proper nouns and technical terms.** Names of people, places and specialised
  vocabulary are the most common errors.
- **Dialect.** Whisper is strongest on Modern Standard Arabic. Gulf, Egyptian
  and Levantine dialects are noticeably harder, and a teacher moving between
  dialect and MSA mid-sentence is harder still.
- **Room audio.** A microphone pointed at a classroom picks up echo and chairs.
  Capturing the audio stream directly is much better than recording the room.
- **Overlapping speakers.** Two people at once degrades it sharply.

Two things in the app help:

- Turn on **Also show the original Arabic under each line** in Settings. When an
  English line looks wrong, you can see what was actually said. For a language
  class this is worth the extra delay on its own — you are there to learn the
  Arabic, not only to bypass it.
- **Polish with my agent** sends the transcript to your local model, which can
  repair recognition errors from context.

Treat the transcript as a very good set of notes, not as a court record.

---

## Following a class

1. Open the app.
2. Under **Them, in English**, choose where the teacher's voice comes from:
   - **Computer sound (meeting audio)** for an online class, a recording or a
     video. This captures what your speakers are playing, including through
     headphones. Best quality, because no microphone is involved.
   - A **microphone** for a teacher in the room with you.
3. Press **Start listening**.
4. Tick **Read aloud in English** if you want to hear it as well as read it.

Lines appear when the teacher pauses, roughly one per sentence, timestamped.

### Read aloud

The voice comes from Windows, so there is nothing extra to install. Choose which
voice and how fast in Settings, under *Reading aloud*.

One behaviour worth knowing: **if the reading falls behind the teacher, older
lines are skipped.** Only the three most recent lines are ever queued. This is
deliberate — in a live class, hearing a sentence from two minutes ago is worse
than missing it. If it skips too often, raise the speaking speed, or turn
reading off and read the text instead.

The line being spoken has a teal bar down its left edge. **Stop reading**
silences it immediately without stopping transcription.

If you see *No English voice installed*, open Windows Settings, then
Time & language, then Speech, and add an English voice.

---

## Dictating to paste elsewhere

Press **Start dictating** and talk. Your words land in the lower box, which is a
normal editable text field — fix anything, then press **Copy**.

By default your speech is translated to English as well, so you can speak Arabic
and paste English. If you would rather have what you said written as you said
it, set *Write my words as* to *The language I spoke* in Settings.

Both halves work at the same time. They share one model and take turns, so heavy
dictation slows the top half slightly. On your GPU that is unlikely to show.

---

## Settings worth changing

**Language they speak** — leave this on Arabic rather than *Detect each time*.
Detection is unreliable on short pieces of speech, and this app deliberately
works in short pieces. Setting it explicitly is the single biggest accuracy win
available to you.

**Pause before a line is finished** (0.70s) — how long a silence must be before
a sentence counts as over. Lengthen it for a slow, deliberate lecturer; shorten
it if lines feel sluggish.

**Quietest sound counted as speech** (0.012) — raise it in a noisy room. The app
also learns your room tone continuously and floats its own threshold above it.

**Model** — `large-v3` is already chosen for you. `medium` gives lower latency.
Avoid **`turbo`**: it was distilled on transcription data only and its English
translation is noticeably worse.

Three behaviours are not adjustable, because they are what make it reliable:
audio from a third of a second *before* speech is kept, so word beginnings are
never clipped; anything with under 0.4 seconds of real voice is discarded, so
coughs never reach the model; and since nobody pauses for 18 seconds, speech is
cut on the clock at that point so the display keeps moving.

---

## Your own agent

**Polish with my agent** appears once you enable it in Settings. Point it at any
server speaking the OpenAI chat format — Ollama, LM Studio, llama.cpp, vLLM —
and it sends the transcript over and puts the cleaned result in the notes box.
The default instruction asks for tidy notes with technical terms intact and
nothing invented. Change it to whatever you need, for example a vocabulary list
of every Arabic word the teacher used.

The request goes from the app's main process, so there is no browser
cross-origin setup needed on your server.

---

## When something goes wrong

**Double-clicking does nothing** — right-click `Arabic Live Notes.bat` and pick
*Run as administrator* once. If Windows SmartScreen blocks it, choose *More
info*, then *Run anyway*; the file is a plain text script you can open and read
first.

**"Python is not installed" but you installed it** — the *Add python.exe to
PATH* box was not ticked. Re-run the Python installer, choose *Modify*, and
enable it.

**Nothing appears when the teacher speaks** — watch the level meter beside
*Them*. Not moving means the wrong source is selected. Moving with no text means
the threshold is too high, or the model is still loading on the first start.

**Text appears but is nonsense** — set the language explicitly rather than
*Detect each time*.

**Lines fall further and further behind** — this should not happen on your GPU.
Check the status bar says *Running large-v3 on your graphics card*. If it says
*on the processor*, run `Repair.bat`.

**The same phrase repeats forever** — Whisper looping on silence. Each utterance
is already decoded independently and the common hallucinations are filtered, but
raise the threshold slider if you meet a new one.

---

## Checking it still works

```
node scripts/test-vad.js
python scripts/test_protocol.py
```

Neither needs a model or a microphone. The first feeds synthetic audio through
the real sentence splitter; the second stands in a fake model and checks the
app-to-engine conversation.

---

## How it fits together

```
microphone / computer sound
        |
   AudioWorklet          64 ms blocks, mono, 16 kHz
        |
   sentence splitter     pre-roll, onset, silence, ceiling
        |
   WebSocket             [length][JSON header][16-bit PCM]
        |
   Python engine         one model, one worker, one at a time
        |
   English text  --->  the screen, and the Windows voice
```

- `Arabic Live Notes.bat` → `scripts/launcher.ps1` — installs and starts.
- `electron/main.js` — window, supervises the Python engine, saves files.
- `renderer/app.js` — capture, splitter, both panes, reading aloud.
- `python/asr_server.py` — the engine.
- `python/vendor/whisper-src` — OpenAI's Whisper source, unmodified.

Whisper is MIT licensed by OpenAI; the licence is at
`python/vendor/whisper-src/LICENSE`.
