'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { storageManager } = require('./storage-manager');

/**
 * RecordingRepository
 * Manages atomic filesystem persistence for classroom recordings,
 * transcripts, timestamped notes, and metadata.
 */
class RecordingRepository {
  constructor(storage = storageManager) {
    this.storage = storage;
  }

  _indexPath() {
    return path.join(this.storage.getDatabaseRoot(), 'index.json');
  }

  _readIndex() {
    try {
      const p = this._indexPath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (err) {
      console.error('[RecordingRepository] Failed to read index:', err);
    }
    return [];
  }

  _writeIndex(entries) {
    try {
      fs.mkdirSync(this.storage.getDatabaseRoot(), { recursive: true });
      fs.writeFileSync(this._indexPath(), JSON.stringify(entries, null, 2), 'utf8');
    } catch (err) {
      console.error('[RecordingRepository] Failed to write index:', err);
    }
  }

  _updateIndexEntry(meta) {
    const list = this._readIndex().filter((e) => e.id !== meta.id);
    list.unshift({
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      duration: meta.duration || 0,
      status: meta.status,
      speakerLanguage: meta.speakerLanguage || 'ar',
      outputLanguage: meta.outputLanguage || 'en',
      transcriptSegmentCount: meta.transcriptSegmentCount || 0,
      translationCount: meta.translationCount || 0,
      noteCount: meta.noteCount || 0,
      cloudBackupStatus: meta.cloudBackupStatus || 'not_enabled',
    });
    // Sort descending by createdAt
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    this._writeIndex(list);
  }

  _removeIndexEntry(id) {
    const list = this._readIndex().filter((e) => e.id !== id);
    this._writeIndex(list);
  }

  /**
   * Create a new recording folder with initial metadata, transcript, and notes files.
   */
  createRecording(data = {}) {
    const id = this.storage.sanitizeId(
      data.id || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    const recDir = this.storage.getRecordingPath(id);
    fs.mkdirSync(recDir, { recursive: true });

    const now = new Date().toISOString();
    const defaultTitle = `Classroom Recording — ${new Date().toLocaleDateString([], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })}, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    const metadata = {
      id,
      title: (data.title && String(data.title).trim()) || defaultTitle,
      createdAt: data.createdAt || now,
      startedAt: data.startedAt || now,
      endedAt: null,
      duration: 0,
      status: 'recording',
      audioFile: 'recording.webm',
      audioFormat: data.audioFormat || 'audio/webm;codecs=opus',
      speakerLanguage: data.speakerLanguage || 'ar',
      outputLanguage: data.outputLanguage || 'en',
      model: data.model || 'large-v3',
      transcriptSegmentCount: 0,
      translationCount: 0,
      noteCount: 0,
      localStorageStatus: 'recording',
      cloudBackupStatus: data.cloudBackupStatus || 'not_enabled',
      cloudFolderId: null,
      cloudFileId: null,
      lastBackupAt: null,
    };

    fs.writeFileSync(path.join(recDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
    fs.writeFileSync(path.join(recDir, 'transcript.json'), JSON.stringify([], null, 2), 'utf8');
    fs.writeFileSync(path.join(recDir, 'notes.json'), JSON.stringify([], null, 2), 'utf8');

    this._updateIndexEntry(metadata);
    return metadata;
  }

  /**
   * Append a raw binary audio chunk to the recording file.
   */
  appendAudioChunk(id, buffer) {
    const recDir = this.storage.getRecordingPath(id);
    const audioPath = path.join(recDir, 'recording.webm');
    fs.appendFileSync(audioPath, Buffer.from(buffer));
    return true;
  }

  /**
   * Incrementally append or update a transcript segment in transcript.json.
   */
  appendSegment(id, segment) {
    if (!segment || !segment.id) return null;
    const recDir = this.storage.getRecordingPath(id);
    const transcriptPath = path.join(recDir, 'transcript.json');

    let segments = [];
    if (fs.existsSync(transcriptPath)) {
      try {
        segments = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      } catch {
        segments = [];
      }
    }

    const idx = segments.findIndex((s) => s.id === segment.id);
    if (idx >= 0) {
      segments[idx] = { ...segments[idx], ...segment };
    } else {
      segments.push(segment);
    }

    return this.saveTranscript(id, segments);
  }

  /**
   * Save the entire transcript array.
   */
  saveTranscript(id, segments) {
    const recDir = this.storage.getRecordingPath(id);
    const transcriptPath = path.join(recDir, 'transcript.json');
    const safeSegments = Array.isArray(segments) ? segments : [];
    fs.writeFileSync(transcriptPath, JSON.stringify(safeSegments, null, 2), 'utf8');

    const metaPath = path.join(recDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.transcriptSegmentCount = safeSegments.length;
        meta.translationCount = safeSegments.filter((s) => s.translatedText).length;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        this._updateIndexEntry(meta);
      } catch { /* ignore */ }
    }

    return safeSegments;
  }

  /**
   * Append or overwrite notes in notes.json.
   */
  saveNotes(id, notes) {
    const recDir = this.storage.getRecordingPath(id);
    const notesPath = path.join(recDir, 'notes.json');
    const safeNotes = Array.isArray(notes) ? notes : [];
    fs.writeFileSync(notesPath, JSON.stringify(safeNotes, null, 2), 'utf8');

    const metaPath = path.join(recDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.noteCount = safeNotes.length;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        this._updateIndexEntry(meta);
      } catch { /* ignore */ }
    }

    return safeNotes;
  }

  /**
   * Add a single timestamped note to notes.json.
   */
  addNote(id, note) {
    const recDir = this.storage.getRecordingPath(id);
    const notesPath = path.join(recDir, 'notes.json');

    let notes = [];
    if (fs.existsSync(notesPath)) {
      try {
        notes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
      } catch {
        notes = [];
      }
    }

    const noteObj = {
      id: note.id || `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      recordingId: id,
      createdAt: note.createdAt || new Date().toISOString(),
      recordingOffset: note.recordingOffset || '00:00',
      recordingOffsetSec: typeof note.recordingOffsetSec === 'number' ? note.recordingOffsetSec : (typeof note.recordingOffset === 'number' ? note.recordingOffset : 0),
      formattedTime: note.formattedTime || (typeof note.recordingOffset === 'string' ? note.recordingOffset : '00:00'),
      segmentId: note.segmentId || null,
      text: String(note.text || '').trim(),
    };

    notes.push(noteObj);
    return this.saveNotes(id, notes);
  }

  /**
   * Update recording metadata.
   */
  updateMetadata(id, patch = {}) {
    const recDir = this.storage.getRecordingPath(id);
    const metaPath = path.join(recDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Recording metadata not found for ID: ${id}`);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const updated = { ...meta, ...patch };
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf8');
    this._updateIndexEntry(updated);
    return updated;
  }

  /**
   * Finalize recording state to 'completed'.
   */
  finalizeRecording(id, finalPatch = {}) {
    const recDir = this.storage.getRecordingPath(id);
    const metaPath = path.join(recDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Recording metadata not found for ID: ${id}`);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const now = new Date().toISOString();
    const updated = {
      ...meta,
      ...finalPatch,
      status: 'completed',
      localStorageStatus: 'saved',
      endedAt: finalPatch.endedAt || now,
    };

    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf8');
    this._updateIndexEntry(updated);
    return updated;
  }

  /**
   * Get transcript segments for a recording.
   */
  getTranscript(id) {
    const full = this.getRecording(id);
    return full ? full.transcript : [];
  }

  /**
   * Get notes for a recording.
   */
  getNotes(id) {
    const full = this.getRecording(id);
    return full ? full.notes : [];
  }

  /**
   * Load full recording object (metadata, transcript, notes, audio path).
   */
  getRecording(id) {
    const recDir = this.storage.getRecordingPath(id);
    const metaPath = path.join(recDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      return null;
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    let transcript = [];
    let notes = [];

    const transcriptPath = path.join(recDir, 'transcript.json');
    if (fs.existsSync(transcriptPath)) {
      try {
        transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      } catch { transcript = []; }
    }

    const notesPath = path.join(recDir, 'notes.json');
    if (fs.existsSync(notesPath)) {
      try {
        notes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
      } catch { notes = []; }
    }

    const audioPath = path.join(recDir, 'recording.webm');
    const audioExists = fs.existsSync(audioPath);
    const audioSize = audioExists ? fs.statSync(audioPath).size : 0;

    return {
      ...metadata,
      metadata: { ...metadata },
      audioPath,
      audioSize,
      audioExists,
      transcript,
      notes,
    };
  }

  /**
   * List all recordings.
   */
  listRecordings() {
    // Rebuild index if missing or scan folder
    const recRoot = this.storage.getRecordingsRoot();
    if (!fs.existsSync(recRoot)) return [];

    const entries = [];
    const items = fs.readdirSync(recRoot, { withFileTypes: true });

    for (const item of items) {
      if (item.isDirectory()) {
        try {
          const metaPath = path.join(recRoot, item.name, 'metadata.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            entries.push(meta);
          }
        } catch { /* ignore corrupted entries */ }
      }
    }

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    this._writeIndex(entries);
    return entries;
  }

  /**
   * Delete a recording folder permanently.
   * If options.deleteCloud is true, also removes the Google Drive cloud backup folder.
   */
  async deleteRecording(id, options = {}) {
    const rec = this.getRecording(id);
    if (options && options.deleteCloud && rec && rec.metadata && rec.metadata.cloudFolderId) {
      try {
        const { googleDrive } = require('./google-drive-client');
        if (googleDrive) {
          await googleDrive.deleteCloudRecording(rec.metadata.cloudFolderId);
        }
      } catch (err) {
        console.warn(`[RecordingRepository] Could not delete cloud folder for ${id}:`, err);
      }
    }

    const recDir = this.storage.getRecordingPath(id);
    if (fs.existsSync(recDir)) {
      fs.rmSync(recDir, { recursive: true, force: true });
    }
    this._removeIndexEntry(id);
    return true;
  }

  /**
   * Rename a recording.
   */
  renameRecording(id, newTitle) {
    if (!newTitle || !String(newTitle).trim()) return null;
    return this.updateMetadata(id, { title: String(newTitle).trim() });
  }

  /**
   * Search recordings across titles, Arabic source text, English translation, and notes.
   */
  search(query) {
    if (!query || !String(query).trim()) {
      return this.listRecordings();
    }

    const term = String(query).trim().toLowerCase();
    const all = this.listRecordings();
    const results = [];

    for (const item of all) {
      // 1. Check title
      if (item.title && item.title.toLowerCase().includes(term)) {
        results.push({ ...item, matchType: 'title' });
        continue;
      }

      // 2. Check transcript and notes
      const full = this.getRecording(item.id);
      if (!full) continue;

      let matched = false;
      if (full.transcript && Array.isArray(full.transcript)) {
        for (const seg of full.transcript) {
          if (
            (seg.sourceText && seg.sourceText.toLowerCase().includes(term)) ||
            (seg.translatedText && seg.translatedText.toLowerCase().includes(term))
          ) {
            results.push({ ...item, matchType: 'transcript', matchedSnippet: seg.translatedText || seg.sourceText });
            matched = true;
            break;
          }
        }
      }

      if (!matched && full.notes && Array.isArray(full.notes)) {
        for (const note of full.notes) {
          if (note.text && note.text.toLowerCase().includes(term)) {
            results.push({ ...item, matchType: 'note', matchedSnippet: note.text });
            break;
          }
        }
      }
    }

    return results;
  }

  /**
   * Detect unfinalized recordings from previous sessions and recover them.
   */
  recoverIncomplete() {
    const list = this.listRecordings();
    const unfinalized = list.filter((r) => r.status === 'recording' || r.status === 'paused');
    const recovered = [];

    for (const r of unfinalized) {
      try {
        const full = this.getRecording(r.id);
        const segments = full ? full.transcript : [];
        let computedDuration = r.duration || 0;
        if (segments.length > 0) {
          const lastSeg = segments[segments.length - 1];
          computedDuration = Math.max(computedDuration, (lastSeg.audioOffset || 0) + (lastSeg.duration || 0));
        }

        const updated = this.updateMetadata(r.id, {
          status: 'recovered',
          localStorageStatus: 'recovered',
          duration: computedDuration,
          endedAt: r.endedAt || new Date().toISOString(),
        });
        recovered.push(updated);
      } catch (err) {
        console.error(`[RecordingRepository] Failed to recover ${r.id}:`, err);
      }
    }

    return recovered;
  }
}

module.exports = {
  RecordingRepository,
  recordingRepo: new RecordingRepository(),
};
