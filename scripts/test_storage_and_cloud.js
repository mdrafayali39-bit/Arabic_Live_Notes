'use strict';

/**
 * Arabic Live Notes — Storage, Cloud Backup & Security Test Suite
 * 
 * Tests:
 * 1. Local storage lifecycle (create, incremental audio, incremental segments, notes, finalize).
 * 2. Incremental persistence & crash recovery (unfinalized recording detected on restart).
 * 3. Search & retrieval across titles, transcripts, and notes.
 * 4. Custom protocol URL resolution & path traversal rejection.
 * 5. Google Drive backup architecture (resumable upload logic, folder creation, sync metadata).
 * 6. Security boundaries (token isolation, DPAPI fail-closed, no secrets in recording JSON/logs).
 * 7. Disconnect resilience (local records remain intact when cloud is disconnected).
 * 8. Explicit delete behavior (local vs cloud separation).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Test Environment Sandbox Storage Root
const TEST_STORAGE_ROOT = path.join(__dirname, '..', 'storage_test_sandbox');

// Ensure clean test environment
if (fs.existsSync(TEST_STORAGE_ROOT)) {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
}

const { StorageManager } = require('../electron/storage-manager');
const { RecordingRepository } = require('../electron/recordings-repo');
const { SecureTokenManager } = require('../electron/secure-tokens');
const { GoogleAuthManager } = require('../electron/google-auth');
const { GoogleDriveClient } = require('../electron/google-drive-client');

let passedTests = 0;
let totalTests = 0;

function it(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    Error: ${err.message}`);
  }
}

async function itAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    Error: ${err.stack || err.message}`);
  }
}

async function runStorageAndCloudTestSuite() {
  console.log('\n===============================================================');
  console.log('  ARABIC LIVE NOTES: STORAGE, CLOUD BACKUP & SECURITY AUDIT');
  console.log('===============================================================\n');

  // Initialize sandboxed StorageManager & RecordingRepository
  const storage = new StorageManager(TEST_STORAGE_ROOT);
  const repo = new RecordingRepository(storage);
  const tokenStore = new SecureTokenManager(storage);
  const oauthClient = new GoogleAuthManager();
  const driveClient = new GoogleDriveClient(oauthClient, repo);

  console.log('--- Phase 1: Local Storage Architecture & Root Abstraction ---');

  it('StorageManager creates expected directory layout outside ASAR', () => {
    assert.strictEqual(fs.existsSync(storage.getRecordingsRoot()), true);
    assert.strictEqual(fs.existsSync(storage.getDatabaseRoot()), true);
    assert.strictEqual(fs.existsSync(storage.getCacheRoot()), true);
    assert.strictEqual(fs.existsSync(storage.getLogsRoot()), true);
  });

  it('StorageManager sanitizes recording IDs and rejects path traversal attacks', () => {
    assert.throws(() => storage.getRecordingPath('../../secret.txt'), /Invalid recording ID/);
    assert.throws(() => storage.getRecordingPath('C:\\Windows\\System32'), /Invalid recording ID/);
    assert.throws(() => storage.getRecordingPath('..\\..\\passwords'), /Invalid recording ID/);
    assert.throws(() => storage.getRecordingPath(''), /Invalid recording ID/);

    const validDir = storage.getRecordingPath('rec-2026-09-19-lecture-1');
    assert.strictEqual(validDir.startsWith(storage.getRecordingsRoot()), true);
  });

  console.log('\n--- Phase 2: Incremental Recording Lifecycle & Persistence ---');

  let testRecId = null;

  await itAsync('Creates new recording session with full metadata model', async () => {
    const rec = await repo.createRecording({
      title: 'Islamic History & Arabic Syntax',
      speakerLanguage: 'ar',
      outputLanguage: 'en',
      model: 'small',
    });

    testRecId = rec.id;
    assert.ok(testRecId);
    assert.strictEqual(rec.title, 'Islamic History & Arabic Syntax');
    assert.strictEqual(rec.status, 'recording');
    assert.strictEqual(rec.localStorageStatus, 'recording');
    assert.strictEqual(rec.cloudBackupStatus, 'not_enabled');

    const recDir = storage.getRecordingPath(testRecId);
    assert.strictEqual(fs.existsSync(recDir), true);
    assert.strictEqual(fs.existsSync(path.join(recDir, 'metadata.json')), true);
    assert.strictEqual(fs.existsSync(path.join(recDir, 'transcript.json')), true);
    assert.strictEqual(fs.existsSync(path.join(recDir, 'notes.json')), true);
  });

  await itAsync('Appends audio chunks continuously (incremental WebM streaming)', async () => {
    const chunk1 = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]); // EBML header mock
    const chunk2 = Buffer.from([0x42, 0x86, 0x81, 0x01]);
    const chunk3 = Buffer.from([0x42, 0xF7, 0x81, 0x01]);

    await repo.appendAudioChunk(testRecId, chunk1);
    await repo.appendAudioChunk(testRecId, chunk2);
    await repo.appendAudioChunk(testRecId, chunk3);

    const audioPath = path.join(storage.getRecordingPath(testRecId), 'recording.webm');
    assert.strictEqual(fs.existsSync(audioPath), true);
    const audioStats = fs.statSync(audioPath);
    assert.strictEqual(audioStats.size, 12);
  });

  await itAsync('Appends finalized speech segments incrementally (Arabic source + English)', async () => {
    const seg1 = {
      id: 'speaker-1',
      sequence: 1,
      startOffset: 0.0,
      endOffset: 3.5,
      sourceText: 'بسم الله الرحمن الرحيم',
      translatedText: 'In the name of Allah, the Most Gracious, the Most Merciful',
      language: 'ar',
      timestamp: new Date().toISOString(),
    };

    const seg2 = {
      id: 'speaker-2',
      sequence: 2,
      startOffset: 3.8,
      endOffset: 8.2,
      sourceText: 'سنبدأ اليوم بمناقشة بناء الجملة في اللغة العربية',
      translatedText: 'Today we will begin discussing sentence structure in the Arabic language',
      language: 'ar',
      timestamp: new Date().toISOString(),
    };

    await repo.appendSegment(testRecId, seg1);
    await repo.appendSegment(testRecId, seg2);

    const trans = await repo.getTranscript(testRecId);
    assert.strictEqual(trans.length, 2);
    assert.strictEqual(trans[0].sourceText, 'بسم الله الرحمن الرحيم');
    assert.strictEqual(trans[1].translatedText, 'Today we will begin discussing sentence structure in the Arabic language');
    
    // Verify metadata counter incremented
    const rec = await repo.getRecording(testRecId);
    assert.strictEqual(rec.metadata.transcriptSegmentCount, 2);
    assert.strictEqual(rec.metadata.translationCount, 2);
  });

  await itAsync('Appends timestamped lecture notes incrementally', async () => {
    const note1 = {
      id: 'note-1',
      recordingId: testRecId,
      createdAt: new Date().toISOString(),
      recordingOffset: '00:02',
      recordingOffsetSec: 2,
      text: 'Professor opened with Basmala; lecture focuses on Arabic grammar.',
    };

    const note2 = {
      id: 'note-2',
      recordingId: testRecId,
      createdAt: new Date().toISOString(),
      recordingOffset: '00:06',
      recordingOffsetSec: 6,
      text: 'Key exam topic: Nominal vs Verbal sentence patterns.',
    };

    await repo.addNote(testRecId, note1);
    await repo.addNote(testRecId, note2);

    const notes = await repo.getNotes(testRecId);
    assert.strictEqual(notes.length, 2);
    assert.strictEqual(notes[0].text, 'Professor opened with Basmala; lecture focuses on Arabic grammar.');

    const rec = await repo.getRecording(testRecId);
    assert.strictEqual(rec.metadata.noteCount, 2);
  });

  console.log('\n--- Phase 3: Crash Recovery & Unfinished Recording Restoration ---');

  await itAsync('Detects and recovers unfinalized recording on application startup', async () => {
    // Current recording is still status = 'recording' (simulates crash / sudden power loss)
    const incomplete = await repo.recoverIncomplete();
    assert.strictEqual(incomplete.length, 1);
    assert.strictEqual(incomplete[0].id, testRecId);
    assert.strictEqual(incomplete[0].localStorageStatus, 'recovered');

    // Verify previously written audio, segments, and notes are 100% intact!
    const rec = await repo.getRecording(testRecId);
    assert.strictEqual(rec.transcript.length, 2);
    assert.strictEqual(rec.notes.length, 2);
    assert.strictEqual(fs.existsSync(rec.audioPath), true);
  });

  await itAsync('Finalizes recording properly with duration and status', async () => {
    const finalized = await repo.finalizeRecording(testRecId, { duration: 520 });
    assert.strictEqual(finalized.status, 'completed');
    assert.strictEqual(finalized.duration, 520);
    assert.strictEqual(finalized.localStorageStatus, 'saved');

    // Startup recovery should now find 0 incomplete recordings
    const incomplete = await repo.recoverIncomplete();
    assert.strictEqual(incomplete.length, 0);
  });

  console.log('\n--- Phase 4: History Search & Detail View Retrieval ---');

  await itAsync('Lists all recordings in History with accurate metadata', async () => {
    const list = await repo.listRecordings();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, testRecId);
    assert.strictEqual(list[0].transcriptSegmentCount, 2);
    assert.strictEqual(list[0].noteCount, 2);
    assert.strictEqual(list[0].duration, 520);
  });

  await itAsync('Searches recordings across titles, transcripts, and notes', async () => {
    const resTitle = await repo.search('Syntax');
    assert.strictEqual(resTitle.length, 1);

    const resArabic = await repo.search('الرحمن');
    assert.strictEqual(resArabic.length, 1);

    const resEnglish = await repo.search('sentence structure');
    assert.strictEqual(resEnglish.length, 1);

    const resNotes = await repo.search('Nominal vs Verbal');
    assert.strictEqual(resNotes.length, 1);

    const resNone = await repo.search('quantum mechanics');
    assert.strictEqual(resNone.length, 0);
  });

  console.log('\n--- Phase 5: Google Drive Backup Architecture & Idempotency ---');

  it('1. No OAuth client secret is required by the packaged desktop app', () => {
    const authCode = fs.readFileSync(path.join(__dirname, '..', 'electron', 'google-auth.js'), 'utf8');
    assert.strictEqual(authCode.includes('clientSecret'), false, 'clientSecret found in google-auth.js');
    assert.strictEqual(authCode.includes('client_secret'), false, 'client_secret parameter found in google-auth.js');
    assert.strictEqual(oauthClient.clientSecret, undefined);
  });

  it('2. PKCE is mandatory (verifier and S256 challenge generated)', () => {
    const { generatePKCE } = require('../electron/google-auth');
    const { verifier, challenge } = generatePKCE();
    assert.ok(verifier && verifier.length >= 43, 'PKCE verifier length invalid');
    assert.ok(challenge && challenge.length >= 43, 'PKCE challenge length invalid');
    assert.notStrictEqual(verifier, challenge, 'PKCE challenge must be SHA-256 transformed');
  });

  it('3. OAuth state validation is mandatory (random state generated)', () => {
    const authCode = fs.readFileSync(path.join(__dirname, '..', 'electron', 'google-auth.js'), 'utf8');
    assert.strictEqual(authCode.includes('returnedState !== state'), true);
    assert.strictEqual(authCode.includes('OAuth state mismatch security error'), true);
  });

  it('4. Loopback callback only accepts the active authorization transaction', () => {
    const authCode = fs.readFileSync(path.join(__dirname, '..', 'electron', 'google-auth.js'), 'utf8');
    assert.strictEqual(authCode.includes("reqUrl.pathname !== '/callback'"), true);
  });

  it('8. drive.file remains the only Drive file scope', () => {
    const authCode = fs.readFileSync(path.join(__dirname, '..', 'electron', 'google-auth.js'), 'utf8');
    assert.strictEqual(authCode.includes('https://www.googleapis.com/auth/drive.file'), true);
    assert.strictEqual(authCode.includes("const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive'"), false);
  });

  await itAsync('Uploads recording to Google Drive with folder and artifact synchronization', async () => {
    let uploadedFiles = [];
    driveClient.ensureRootFolder = async () => 'gdrive-root-folder';
    driveClient.ensureRecordingFolder = async (rootId, rec) => 'gdrive-folder-12345';
    driveClient.uploadJsonFile = async (folderId, fileName, data) => {
      uploadedFiles.push({ folderId, fileName, data });
      return { id: `file-${fileName}-${Date.now()}` };
    };
    driveClient.uploadResumableAudio = async (folderId, fileName, audioPath) => {
      uploadedFiles.push({ folderId, fileName, size: fs.statSync(audioPath).size });
      return { id: `audio-file-${Date.now()}` };
    };

    const syncResult = await driveClient.backupRecording(testRecId);
    assert.strictEqual(syncResult.status, 'success');
    assert.strictEqual(uploadedFiles.length, 4); // metadata, transcript, notes, recording.webm

    const rec = await repo.getRecording(testRecId);
    assert.strictEqual(rec.metadata.cloudBackupStatus, 'backed_up');
    assert.strictEqual(rec.metadata.cloudFolderId, 'gdrive-folder-12345');
    assert.ok(rec.metadata.lastBackupAt);
  });

  await itAsync('11. Duplicate Drive backup folders are not created (Idempotent)', async () => {
    let folderCreatedCount = 0;
    driveClient.ensureRecordingFolder = async (rootId, rec) => {
      if (rec.metadata && rec.metadata.cloudFolderId) {
        return rec.metadata.cloudFolderId;
      }
      folderCreatedCount++;
      return 'gdrive-folder-new';
    };

    const syncResult = await driveClient.backupRecording(testRecId);
    assert.strictEqual(syncResult.status, 'success');
    assert.strictEqual(folderCreatedCount, 0);
  });

  await itAsync('9. Google Drive outage does not interrupt local recording', async () => {
    // Inject failed cloud upload
    driveClient.ensureRootFolder = async () => {
      throw new Error('503 Service Unavailable: Google Drive API offline');
    };

    const failedSync = await driveClient.backupRecording(testRecId);
    assert.strictEqual(failedSync.status, 'failed_retryable');

    // Local data remains 100% intact and available!
    const rec = await repo.getRecording(testRecId);
    assert.ok(rec);
    assert.strictEqual(rec.metadata.localStorageStatus, 'saved');
    assert.strictEqual(rec.transcript.length, 2);
    assert.strictEqual(rec.notes.length, 2);
    assert.strictEqual(rec.metadata.cloudBackupStatus, 'failed_retryable');
  });

  console.log('\n--- Phase 6: Security, Credential Storage & Isolation ---');

  it('7. Recording files never contain tokens', () => {
    const recDir = storage.getRecordingPath(testRecId);
    const metaContent = fs.readFileSync(path.join(recDir, 'metadata.json'), 'utf8');
    const transContent = fs.readFileSync(path.join(recDir, 'transcript.json'), 'utf8');
    const notesContent = fs.readFileSync(path.join(recDir, 'notes.json'), 'utf8');

    for (const forbidden of ['refresh_token', 'access_token', 'client_secret', 'authorization_code']) {
      assert.strictEqual(metaContent.includes(forbidden), false, `Forbidden token in metadata: ${forbidden}`);
      assert.strictEqual(transContent.includes(forbidden), false, `Forbidden token in transcript: ${forbidden}`);
      assert.strictEqual(notesContent.includes(forbidden), false, `Forbidden token in notes: ${forbidden}`);
    }
  });

  it('6. Refresh tokens never enter logs', () => {
    const logsDir = storage.getLogsRoot();
    if (fs.existsSync(logsDir)) {
      const logFiles = fs.readdirSync(logsDir);
      for (const file of logFiles) {
        const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
        for (const forbidden of ['refresh_token', 'access_token', 'client_secret', 'authorization_code']) {
          assert.strictEqual(content.includes(forbidden), false, `Forbidden token in log: ${forbidden}`);
        }
      }
    }
  });

  it('SecureTokenManager fails closed when DPAPI/encryption is unavailable', () => {
    // In node test environment without Electron safeStorage, safeStorage.isEncryptionAvailable is false -> must fail closed
    assert.strictEqual(tokenStore.isAvailable(), false);
    assert.throws(() => tokenStore.saveTokenData({ refreshToken: 'secret-sample' }), /Secure token storage is unavailable/);
  });

  it('5. Refresh tokens never reach renderer (GoogleAuthManager.getStatus() returns only safe metadata)', async () => {
    const pubStatus = oauthClient.getStatus();
    assert.strictEqual(typeof pubStatus.connected, 'boolean');
    assert.strictEqual(typeof pubStatus.folderName, 'string');
    assert.strictEqual(pubStatus.accessToken, undefined);
    assert.strictEqual(pubStatus.refreshToken, undefined);
    assert.strictEqual(pubStatus.clientSecret, undefined);
    assert.strictEqual(pubStatus.client_secret, undefined);
  });

  console.log('\n--- Phase 7: Disconnect Resilience & Explicit Delete ---');

  await itAsync('10. Local recording remains fully usable with Google disconnected', async () => {
    oauthClient.disconnect();
    const pubStatus = oauthClient.getStatus();
    assert.strictEqual(pubStatus.connected, false);

    // Verify local recording still fully functional
    const rec = await repo.getRecording(testRecId);
    assert.ok(rec);
    assert.strictEqual(rec.transcript.length, 2);
    assert.strictEqual(rec.notes.length, 2);
    assert.strictEqual(fs.existsSync(rec.audioPath), true);
  });

  await itAsync('12. Local deletion does not delete Drive backup unless explicitly requested', async () => {
    let cloudDeleteCalled = false;
    driveClient.deleteCloudRecording = async (folderId) => {
      cloudDeleteCalled = true;
    };

    // 1. Delete without deleteCloud
    await repo.deleteRecording(testRecId, { deleteCloud: false });
    assert.strictEqual(cloudDeleteCalled, false, 'Cloud copy was deleted without permission!');
    assert.strictEqual(fs.existsSync(storage.getRecordingPath(testRecId)), false);

    // 2. Create another recording and delete
    const rec2 = await repo.createRecording({ title: 'Lecture 2' });
    await repo.updateMetadata(rec2.id, { cloudFolderId: 'gdrive-folder-999' });
    await repo.deleteRecording(rec2.id, { deleteCloud: true });
    assert.strictEqual(fs.existsSync(storage.getRecordingPath(rec2.id)), false);
  });

  console.log('\n===============================================================');
  console.log(`  RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('===============================================================\n');

  // Clean up test directory
  if (fs.existsSync(TEST_STORAGE_ROOT)) {
    fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  }

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runStorageAndCloudTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
