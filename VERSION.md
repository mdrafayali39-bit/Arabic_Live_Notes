# Arabic Live Notes — Version v2.1.0 Documentation

## 1. Version Information
- **Version**: `v2.1.0 — Classroom Framework`
- **Parent Baseline**: `main @ 284b26cbb8127e61d8112d562cb079a8bcc06e73`
- **Release Date**: 2026-09-19
- **Branch**: `version/v2.1.0-classroom-framework`
- **Status**: Standalone software release snapshot. **Intentionally unmerged into `main`**.

---

## 2. Purpose & Objectives
Version `v2.1.0` transforms Arabic Live Notes from a real-time speech translation and dictation utility into a comprehensive, standalone **Classroom Recording, History, Note-Taking, and Review Platform**. It wraps the proven speech-recognition pipeline with durable, local-first persistent storage, an interactive application shell, and optional Google Drive cloud synchronization.

---

## 3. Previous Platform State (v2.0.0 Baseline)
- **Live-Only Memory**: Transcription and translation state lived exclusively in renderer runtime memory (`SegmentStore`).
- **No Persistence**: Once the window was closed or the system restarted, previous lecture audio, transcripts, and translations were lost.
- **No Session History**: No interface to browse, search, or review past classroom recordings.
- **No Note-Taking**: No timestamped note authoring linked to speech segments or audio offsets.
- **No Cloud Backup**: No synchronization mechanism for archiving classroom recordings.

---

## 4. Changes & Features Introduced in v2.1.0

### 4.1 Application Shell & Navigation
- **Navigation Drawer** (`#nav-drawer`, `#drawer-backdrop`): Smooth off-canvas navigation drawer offering direct access to:
  - *Live Recording & Classroom* (`#view-home`)
  - *New Recording Session*
  - *Recording History* (`#view-history`)
  - *Settings & Storage* (`#settings`)
- **Active Recording Header Bar** (`#recording-bar`): Top rail displaying live status pill (`REC` / `PAUSED`), elapsed timer (`00:00:00`), active lecture title, and `[Pause]` / `[Stop & Save]` controls.
- **Settings Drawer** (`#settings`): Off-canvas right-side panel with keyboard (`Escape`) and click-outside dismissal.

### 4.2 Local-First Storage Architecture
- **Dedicated Storage Root**: Abstracted through `StorageManager` (`storage/recordings/`, `storage/database/`, `storage/cache/`, `storage/logs/`).
- **Per-Recording Isolation**: Each lecture session creates a dedicated folder:
  ```text
  storage/recordings/<recording-id>/
      ├── recording.webm      # Continuous MediaRecorder Opus audio stream
      ├── metadata.json       # Session metrics, language, duration, sync status
      ├── transcript.json     # Finalized Arabic & English speech segments
      └── notes.json          # Timestamped lecture notes
  ```
- **Incremental Streaming**: Audio timeslices and finalized speech segments write continuously to disk, ensuring that a system crash after 45 minutes preserves all 45 minutes of captured data.

### 4.3 Startup Crash Recovery
- Automatically inspects `storage/recordings/` on boot for unfinalized sessions (`"status": "recording"`).
- Displays `#crash-recovery-banner` with `[Open]`, `[Finalize & Save]`, and `[Delete]` options.

### 4.4 Recording History & Detail View
- **History View** (`#view-history`): Offline list of all past lectures displaying duration, date, segment counts, note counts, and local/cloud status badges.
- **Full-Text Search**: Instant search filtering across lecture titles, Arabic source text, English translations, and note contents.
- **Interactive Detail Player** (`#view-detail`):
  - Custom protocol streaming (`aln-recording://<id>/audio`) with HTTP 206 range requests for seeking.
  - Playback speed selector (`1.0x`, `1.25x`, `1.5x`, `2.0x`).
  - Synchronized transcript timeline: clicking any segment seeks audio directly to its start timestamp.
  - Clickable timestamped notes: clicking a note seeks the audio player to its exact offset.
  - JSON export and explicit delete modal (with optional cloud backup deletion).

### 4.5 Live Timestamped Notes
- Live sidebar composer allowing students to take notes during lecture.
- Each note records `{ noteId, recordingId, createdAt, recordingOffset, recordingOffsetSec, text }`.
- Persisted incrementally to `notes.json`.

### 4.6 Audio Output Monitoring Switch
- Dedicated `[ Audio: English ]` vs `[ Audio: Original ]` toggle.
- Switches between English TTS output and direct classroom audio monitoring without clearing buffers, dropping queues, or restarting recognition.

### 4.7 Google Drive Cloud Backup (PKCE)
- **Optional Secondary Backup**: Local storage remains authoritative; cloud backup is completely asynchronous.
- **Pure Desktop PKCE**: OAuth 2.0 Authorization Code flow with PKCE (`S256`) and ephemeral loopback redirect (`http://127.0.0.1:<port>/callback`). **Zero client secret required or embedded**.
- **Minimal Scope**: Strictly `https://www.googleapis.com/auth/drive.file` and `userinfo.email`.
- **Fail-Closed Token Storage**: Refresh tokens encrypted via Windows DPAPI (`auth.enc`). Plaintext fallback is rejected.
- **Visible Folder**: Archives recordings in `ArabicLiveNotes Recordings/<Title> - <Date> (<id>)/`.
- **Resumable Uploads**: Uses Google Drive Resumable Upload protocol for large audio files.

### 4.8 Speaker Diarization Readiness
- Extended the Segment data model across `SegmentStore`, `RecordingRepository`, and `RecordingSessionManager`:
  - `speakerId: 'speaker-1'`
  - `speakerLabel: 'Primary Speaker (Teacher)'`
  - `speakerConfidence: 1.0`
  - `speakerStart: number`
  - `speakerEnd: number`

### 4.9 UI State Machine Architecture
- **Recording State**: `idle` → `preparing` → `recording` ⇄ `paused` → `stopping` → `finalizing` → `complete` (or `recovered` / `error`).
- **Segment State**: `capturing` → `transcribing` → `translated` → `speaking` → `complete` (or `retrying` / `error`).
- **Cloud State**: `disabled` → `waiting` → `uploading` → `synced` (or `failed_retryable`).

---

## 5. Files & Modules Changed

| File | Subsystem | Description |
|:---|:---|:---|
| `electron/storage-manager.js` | Storage | Configurable directory layout and path traversal rejection (`sanitizeId`). |
| `electron/recordings-repo.js` | Storage | Atomic incremental persistence for audio, segments, notes, metadata, and search. |
| `electron/secure-tokens.js` | Security | OS-protected token encryption (Windows DPAPI) with fail-closed security. |
| `electron/google-auth.js` | Auth / Cloud | System browser OAuth 2.0 PKCE flow, loopback server, and token refresh without client secrets. |
| `electron/google-drive-client.js` | Cloud | Google Drive API client with resumable audio upload and folder synchronization. |
| `electron/preload.js` | IPC | Secure renderer bridge exposing scoped recording, storage, and cloud methods. |
| `electron/main.js` | Electron Main | IPC handlers, window lifecycle, and secure `aln-recording://` custom protocol handler. |
| `renderer/index.html` | Frontend UI | Navigation drawer, active recording bar, live notes panel, history view, detail view, delete modal. |
| `renderer/styles.css` | Frontend CSS | Off-canvas drawer and settings styles, recording pill, history cards, audio seeker, and badges. |
| `renderer/app.js` | Frontend Logic | `RecordingSessionManager`, `viewRouter`, incremental segment/notes persistence, audio routing, event listeners. |
| `scripts/test_recordings_framework.js` | Testing | Unit and integration test suite for session creation, segment offsets, notes, and detail loading. |
| `scripts/test_storage_and_cloud.js` | Testing | Verification suite for local storage layout, crash recovery, search, PKCE, and 12 security audit checks. |

---

## 6. Speech Architecture Preserved (Zero Regression)
- **Loss-Minimizing VAD**: Pre-roll buffering (`PREROLL_MS = 384ms`), short word retention (`MIN_VOICED_MS = 150ms`), 18-second rollover boundary preservation (`OVERLAP_BLOCKS = 6`), and noise floor clamping.
- **Whisper Arabic ASR**: Native Arabic recognition (`language='ar'`, `task='transcribe'`) on OpenAI Whisper `large-v3` / `small`.
- **Immutable SegmentStore**: Source of truth preventing downstream translation/TTS errors from altering or dropping captured Arabic text.
- **Lossless Sequential TTS Queue**: FIFO utterance delivery without arbitrary line-skipping, protected by a SpeechSynthesis watchdog recovery timer.
- **Microphone / Loopback Separation**: AEC/NS/AGC applied only to physical microphone inputs; system loopback meeting audio captured raw.

---

## 7. Security & Privacy Audit Findings
1. **Zero Plaintext Tokens**: Verified no refresh tokens, access tokens, or secrets exist in recording JSON, logs, or renderer memory.
2. **Fail-Closed Credential Storage**: Rejects saving credentials if OS DPAPI encryption is unavailable.
3. **Strict Path Traversal Protection**: Rejects `..`, `/`, `\`, and `:` in recording IDs for all IPC and protocol handlers.
4. **Explicit Cloud Deletion**: Deleting a local recording never deletes Google Drive backups unless explicitly confirmed by the user.
5. **Firewall Integrity**: `.gitignore` comprehensively ignores `storage/`, `*.webm`, `*.enc`, `*.pt`, and virtual environments.

---

## 8. Test Suite Verification (111 / 111 Passed)

| Suite | File | Checks Passed | Result |
|---|---|---|---|
| 1. VAD & Boundary Preservation | `scripts/test-vad.js` | **12 / 12** | **PASS** |
| 2. Protocol & Whisper ASR/Translation | `scripts/test_protocol.py` | **17 / 17** | **PASS** |
| 3. Pipeline End-to-End & Invariants | `scripts/test_pipeline_e2e.js` | **11 / 11** | **PASS** |
| 4. Production Validation & Stress | `scripts/production_validation_suite.js` | **16 / 16** | **PASS** |
| 5. Field Quality & Audio Output Routing | `scripts/test_field_quality.js` | **10 / 10** | **PASS** |
| 6. Final Live Acceptance (14.5 min Lecture) | `scripts/final_live_acceptance_suite.js` | **16 / 16** | **PASS** |
| 7. Recordings Framework & Diarization | `scripts/test_recordings_framework.js` | **5 / 5** | **PASS** |
| 8. Storage, Cloud Backup & 12 Security Tests | `scripts/test_storage_and_cloud.js` | **24 / 24** | **PASS** |
| **TOTAL** | | **111 / 111** | **100% PASS** |

---

## 9. Known Limitations
1. **Physical Acoustic Isolation**: When using open-air laptop speakers with high speaker volume, synthesized speech can leak into a sensitive laptop microphone. Headphones provide complete acoustic isolation.
2. **Translation Engine Runtime**: Pass 1 produces immutable Arabic source text, and Pass 2 currently decodes via Whisper translation. The SegmentStore architecture is prepared for local LLM text-to-text translation in a future version.
3. **Cloud Backup**: Google Drive synchronization requires active internet; all local recording, notes, transcription, and history functions operate 100% offline.

---

## 10. Disaster Recovery Purpose
> **This branch is an independently recoverable software version and is intentionally not merged into main.**
> 
> The repository maintains `main` as the frozen baseline reference snapshot. All v2.1.0 classroom framework capabilities are self-contained within this version branch for long-term archival and disaster recovery.
