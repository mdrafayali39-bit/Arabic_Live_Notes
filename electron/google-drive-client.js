'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { googleAuth } = require('./google-auth');
const { recordingRepo } = require('./recordings-repo');

/**
 * GoogleDriveClient
 * Manages asynchronous cloud backup of recordings, transcripts, and notes
 * using the narrow 'drive.file' scope.
 */
class GoogleDriveClient {
  constructor(auth = googleAuth, repo = recordingRepo) {
    this.auth = auth;
    this.repo = repo;
    this.cachedRootFolderId = null;
    this.uploadQueue = new Set();
  }

  async _fetchWithAuth(url, options = {}) {
    const token = await this.auth.getAccessToken();
    if (!token) {
      throw new Error('Not authenticated with Google Drive. Please connect in Settings.');
    }
    const headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    };
    return fetch(url, { ...options, headers });
  }

  /**
   * Finds or creates the visible 'ArabicLiveNotes Recordings' folder in user's My Drive.
   */
  async ensureRootFolder() {
    if (this.cachedRootFolderId) {
      return this.cachedRootFolderId;
    }

    const query = encodeURIComponent(
      "name = 'ArabicLiveNotes Recordings' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    );
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`;
    const searchResp = await this._fetchWithAuth(searchUrl);

    if (searchResp.ok) {
      const data = await searchResp.json();
      if (data.files && data.files.length > 0) {
        this.cachedRootFolderId = data.files[0].id;
        return this.cachedRootFolderId;
      }
    }

    // Create root folder in My Drive
    const createResp = await this._fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ArabicLiveNotes Recordings',
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    if (!createResp.ok) {
      const err = await createResp.text();
      throw new Error(`Failed to create root Google Drive folder: ${err}`);
    }

    const folder = await createResp.json();
    this.cachedRootFolderId = folder.id;
    return this.cachedRootFolderId;
  }

  /**
   * Finds or creates a subfolder for a specific recording.
   */
  async ensureRecordingFolder(rootFolderId, recording) {
    if (recording.cloudFolderId) {
      // Verify folder still exists
      const checkResp = await this._fetchWithAuth(
        `https://www.googleapis.com/drive/v3/files/${recording.cloudFolderId}?fields=id,trashed`
      );
      if (checkResp.ok) {
        const f = await checkResp.json();
        if (!f.trashed) return f.id;
      }
    }

    const folderTitle = `${recording.title || 'Classroom Recording'} - ${recording.id}`;
    const query = encodeURIComponent(
      `name = '${folderTitle.replace(/'/g, "\\'")}' and '${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const searchResp = await this._fetchWithAuth(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`
    );

    if (searchResp.ok) {
      const data = await searchResp.json();
      if (data.files && data.files.length > 0) {
        return data.files[0].id;
      }
    }

    // Create recording folder
    const createResp = await this._fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderTitle,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [rootFolderId],
      }),
    });

    if (!createResp.ok) {
      const err = await createResp.text();
      throw new Error(`Failed to create recording subfolder in Google Drive: ${err}`);
    }

    const folder = await createResp.json();
    return folder.id;
  }

  /**
   * Upload small JSON file via multipart upload.
   */
  async uploadJsonFile(folderId, fileName, jsonData) {
    const boundary = '-------aln_boundary_' + Date.now();
    const metadata = {
      name: fileName,
      parents: [folderId],
    };

    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const body =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(jsonData, null, 2) +
      closeDelimiter;

    const resp = await this._fetchWithAuth(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Failed to upload ${fileName} to Google Drive: ${err}`);
    }

    return resp.json();
  }

  /**
   * Upload audio file using Google Drive resumable upload session.
   */
  async uploadResumableAudio(folderId, fileName, audioPath) {
    if (!fs.existsSync(audioPath)) {
      return null;
    }

    const fileSize = fs.statSync(audioPath).size;
    if (fileSize === 0) return null;

    // 1. Initialize resumable session
    const initResp = await this._fetchWithAuth(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'audio/webm',
          'X-Upload-Content-Length': String(fileSize),
        },
        body: JSON.stringify({
          name: fileName,
          parents: [folderId],
        }),
      }
    );

    if (!initResp.ok) {
      const err = await initResp.text();
      throw new Error(`Failed to initialize resumable audio upload: ${err}`);
    }

    const sessionUri = initResp.headers.get('location');
    if (!sessionUri) {
      throw new Error('Google Drive upload did not return a session URI.');
    }

    // 2. Upload file buffer
    const audioBuffer = fs.readFileSync(audioPath);
    const uploadResp = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': 'audio/webm',
      },
      body: audioBuffer,
    });

    if (!uploadResp.ok && uploadResp.status !== 201 && uploadResp.status !== 200) {
      const err = await uploadResp.text();
      throw new Error(`Failed to upload audio payload: ${err}`);
    }

    return uploadResp.json();
  }

  /**
   * Full asynchronous backup of a local recording to Google Drive.
   */
  async backupRecording(recordingId) {
    if (this.uploadQueue.has(recordingId)) {
      return { status: 'already_uploading' };
    }

    const rec = this.repo.getRecording(recordingId);
    if (!rec) {
      throw new Error(`Recording ${recordingId} not found locally.`);
    }

    this.uploadQueue.add(recordingId);
    this.repo.updateMetadata(recordingId, { cloudBackupStatus: 'uploading' });

    try {
      const rootFolderId = await this.ensureRootFolder();
      const recFolderId = await this.ensureRecordingFolder(rootFolderId, rec);

      // Upload JSON artifacts
      await this.uploadJsonFile(recFolderId, 'metadata.json', {
        ...rec,
        cloudFolderId: recFolderId,
        cloudBackupStatus: 'backed_up',
        lastBackupAt: new Date().toISOString(),
      });
      await this.uploadJsonFile(recFolderId, 'transcript.json', rec.transcript || []);
      await this.uploadJsonFile(recFolderId, 'notes.json', rec.notes || []);

      // Upload audio
      const audioPath = path.join(this.repo.storage.getRecordingPath(recordingId), 'recording.webm');
      let audioFileId = null;
      if (fs.existsSync(audioPath)) {
        const audioRes = await this.uploadResumableAudio(recFolderId, 'recording.webm', audioPath);
        if (audioRes) audioFileId = audioRes.id;
      }

      const updated = this.repo.updateMetadata(recordingId, {
        cloudBackupStatus: 'backed_up',
        cloudFolderId: recFolderId,
        cloudFileId: audioFileId,
        lastBackupAt: new Date().toISOString(),
      });

      this.uploadQueue.delete(recordingId);
      return { status: 'success', metadata: updated };
    } catch (err) {
      this.uploadQueue.delete(recordingId);
      this.repo.updateMetadata(recordingId, { cloudBackupStatus: 'failed_retryable', lastBackupError: err.message });
      console.error(`[GoogleDriveClient] Backup failed for ${recordingId}:`, err.message || err);
      return { status: 'failed_retryable', error: err.message };
    }
  }

  getFolderUrl(folderId) {
    if (!folderId) return 'https://drive.google.com';
    return `https://drive.google.com/drive/folders/${folderId}`;
  }
}

module.exports = {
  GoogleDriveClient,
  googleDriveClient: new GoogleDriveClient(),
};
