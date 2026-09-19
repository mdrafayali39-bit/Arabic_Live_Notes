# Arabic Live Notes — Classroom Recording, Transcription & Review

A standalone classroom recording, live transcription, translation, timestamped note-taking, and review application for lectures taught in Arabic.

---

## Key Capabilities

- **Live Classroom Transcription**: Listens to the teacher's voice and displays verified Arabic source text and English translations in real time.
- **Durable Local-First Recording**: Audio timeslices (`MediaRecorder` Opus stream), finalized speech segments, and notes write continuously to local disk (`storage/recordings/<recording-id>/`), surviving unexpected crashes and system restarts.
- **Lossless Sequential TTS**: Speaks English translations into your headphones in strict sequential FIFO order without dropping lines. Speaking speed is adjustable (`0.6x`–`2.0x`).
- **Audio Output Monitoring Switch**: Toggle between `[ Audio: English ]` (TTS audible, original muted) and `[ Audio: Original ]` (original lecture audio audible, TTS muted) on the fly without interrupting recognition or clearing buffers.
- **Live Timestamped Notes**: Take notes during class that automatically link to the exact audio playback timestamp and corresponding transcript segment.
- **Recording History & Full-Text Search**: Browse past lectures offline and search instantly across titles, Arabic transcripts, English translations, and notes.
- **Interactive Playback & Review**: Dedicated detail player with audio seeking, speed controls (`1.0x`–`2.0x`), synchronized transcript jumping, and JSON export.
- **Optional Google Drive Cloud Backup**: Asynchronous backup to a visible `ArabicLiveNotes Recordings` folder in Google Drive using secure desktop OAuth 2.0 PKCE (`S256`), narrow `drive.file` scope, and Windows DPAPI encrypted token storage.

---

## Starting the Application

Unzip the folder somewhere permanent — your Documents or dedicated directory is fine, but do not run it from inside the zip viewer.

Then **double-click `Arabic Live Notes.bat`**.

The first time, it installs prerequisites, initializes the Python engine, and places an **Arabic Live Notes** shortcut on your desktop.

After that, launch via the desktop shortcut or batch script.

If any dependencies break later, double-click **`Repair.bat`**.

---

## System Requirements

- **Windows 10 / 11** (64-bit)
- **Python 3.9+** (ensure *Add python.exe to PATH* is checked)
- **Node.js LTS**
- **NVIDIA GPU** (recommended, e.g. RTX 4050+ with 6 GB VRAM for `large-v3` CUDA acceleration)

---

## Application Navigation

The application uses an intuitive navigation drawer accessible via the top-left hamburger menu (`☰`):

- **🎙️ Live Recording & Classroom**: Active workspace showing the live translation stage, dictation deck, level meters, audio output switch, and live timestamped notes sidebar.
- **➕ New Recording Session**: Starts a new persistent lecture recording with custom title and language settings.
- **📚 Recording History**: Browse, search, review, back up, or delete past classroom recordings.
- **⚙️ Settings & Storage**: Configure speech models (`large-v3`, `small`, etc.), VAD silence/threshold sliders, TTS voice/rate, local storage paths, and Google Drive connection.

---

## Classroom Workflow

1. Open the application.
2. Select your audio input:
   - **Computer sound (meeting audio)**: Captures meeting sound or video stream directly in high fidelity.
   - **Microphone**: For an in-person teacher in the classroom.
3. Choose your audio monitoring mode:
   - **Audio: English**: Hear translated English spoken through TTS.
   - **Audio: Original**: Hear the teacher's authentic voice directly.
4. Press **Start listening**.
5. During the lecture:
   - Real-time Arabic text and English translations land sequentially.
   - Type notes into the right sidebar and press Enter to timestamp them against the lecture clock.
   - The top rail displays recording status (`REC` / `PAUSED`), elapsed timer, and title.
6. Press **Stop & Save** when class ends.
   - All audio, transcripts, translations, and notes are saved locally to `storage/recordings/`.
   - If Google Drive is connected, an asynchronous background backup syncs to your Drive.

---

## Reviewing Past Lectures

1. Open **Recording History** from the drawer or top rail (`History`).
2. Search for any term across titles, Arabic phrases, English translations, or your personal notes.
3. Click any lecture card to open **Lecture Details**:
   - Use the interactive audio player to listen and seek.
   - Click any transcript segment to jump audio directly to that moment.
   - Click any timestamped note (`⏱ 04:12`) to seek the player to when you wrote that note.
   - Export lecture data as JSON or delete local/cloud copies.

---

## Local Storage & Cloud Security

- **Local Storage is Primary**: The app works 100% offline. Recordings are saved in `storage/recordings/<recording-id>/` outside ASAR packages.
- **Zero Plaintext Tokens**: Google OAuth refresh tokens are stored exclusively in `storage/database/auth.enc` encrypted via Windows DPAPI (fail-closed).
- **Narrow Scopes**: Requests only `https://www.googleapis.com/auth/drive.file` and `userinfo.email`.
- **System Browser PKCE**: Authenticates via the default system browser with dynamic PKCE code challenges on an ephemeral loopback port (`http://127.0.0.1:<port>/callback`). Zero client secrets are required or stored.

---

## Verifying Pipeline & Regression Tests

Run the complete test suite locally:

```bash
# VAD & boundary preservation
node scripts/test-vad.js

# Whisper Python engine protocol
python scripts/test_protocol.py

# End-to-end pipeline invariants
node scripts/test_pipeline_e2e.js

# Production stress & hardware mic isolation
node scripts/production_validation_suite.js

# Field quality & audio routing
node scripts/test_field_quality.js

# Live continuous classroom acceptance
node scripts/final_live_acceptance_suite.js

# Recordings framework & diarization readiness
node scripts/test_recordings_framework.js

# Storage, crash recovery, PKCE & 12 security checks
node scripts/test_storage_and_cloud.js
```

---

## License

- Whisper engine is MIT licensed by OpenAI (`python/vendor/whisper-src/LICENSE`).
- Arabic Live Notes is licensed for personal and educational classroom use.
