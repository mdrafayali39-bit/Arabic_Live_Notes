'use strict';

const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, dialog, protocol, net } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const PYTHON_DIR = path.join(ROOT, 'python');
const MODELS_DIR = path.join(ROOT, 'models');

const { storageManager } = require('./storage-manager');
const { recordingRepo } = require('./recordings-repo');
const { googleAuth } = require('./google-auth');
const { googleDriveClient } = require('./google-drive-client');

// Register custom protocol scheme privileges before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aln-recording',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

let mainWindow = null;
let engine = null;          // child process
let enginePort = null;
let engineModel = null;     // which weights the running process has loaded
let engineLog = [];         // last lines of stderr, surfaced in the UI on failure

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS = {
  model: 'small',
  speakerLanguage: 'ar',
  speakerTask: 'translate',
  showSource: false,
  readAloud: false,
  voiceURI: '',
  voiceRate: 1.0,
  myLanguage: 'ar',
  myTask: 'translate',
  silenceMs: 700,
  threshold: 0.012,
  maxUtteranceMs: 18000,
  storageRoot: '',
  googleBackupEnabled: false,
  agent: {
    enabled: false,
    url: 'http://127.0.0.1:1234/v1/chat/completions',
    model: 'local-model',
    apiKey: '',
    prompt:
      'You are cleaning up a live transcript of an IT meeting. Fix obvious ' +
      'speech-recognition errors, restore punctuation, keep technical terms ' +
      'and product names intact, and return tidy meeting notes in English. ' +
      'Do not invent anything that was not said.',
  },
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULTS, ...raw, agent: { ...DEFAULTS.agent, ...(raw.agent || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  if (merged.storageRoot) {
    storageManager.setRoot(merged.storageRoot);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Python sidecar
// ---------------------------------------------------------------------------

function pythonExecutable() {
  const venv =
    process.platform === 'win32'
      ? path.join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe')
      : path.join(PYTHON_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function installedModels() {
  try {
    return fs
      .readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith('.pt'))
      .map((f) => f.replace(/\.pt$/, ''));
  } catch {
    return [];
  }
}

function startEngine(model) {
  stopEngine();
  engineLog = [];

  return new Promise((resolve, reject) => {
    const exe = pythonExecutable();
    const args = [path.join(PYTHON_DIR, 'asr_server.py'), '--model', model, '--models-dir', MODELS_DIR];

    const child = spawn(exe, args, {
      cwd: PYTHON_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    engine = child;
    engineModel = model;
    let settled = false;
    let stdout = '';

    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'listening' && !settled) {
            settled = true;
            enginePort = msg.port;
            resolve(msg.port);
          }
        } catch {
          engineLog.push(line);
        }
      }
    });

    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      engineLog.push(...text.split('\n').filter(Boolean));
      if (engineLog.length > 200) engineLog = engineLog.slice(-200);
      send('engine:log', text);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Could not start Python (${exe}). ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      engine = null;
      enginePort = null;
      send('engine:exit', { code, log: engineLog.slice(-40) });
      if (!settled) {
        settled = true;
        reject(new Error(`The speech engine stopped before it was ready (exit ${code}).\n\n${engineLog.slice(-12).join('\n')}`));
      }
    });
  });
}

function stopEngine() {
  if (engine && !engine.killed) {
    engine.kill();
  }
  engine = null;
  enginePort = null;
  engineModel = null;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 780,
    minHeight: 600,
    backgroundColor: '#10151C',
    show: false,
    title: 'Arabic Live Notes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Apply saved custom storage root if any
  const initialSettings = loadSettings();
  if (initialSettings.storageRoot) {
    storageManager.setRoot(initialSettings.storageRoot);
  }

  // Register secure custom protocol for historical recording audio playback
  protocol.handle('aln-recording', async (request) => {
    try {
      const parsed = new URL(request.url);
      const recordingId = parsed.hostname || parsed.pathname.replace(/^\/+/, '').split('/')[0];
      const cleanId = storageManager.sanitizeId(recordingId);
      const audioPath = path.join(storageManager.getRecordingPath(cleanId), 'recording.webm');

      if (!fs.existsSync(audioPath)) {
        return new Response('Recording audio not found', { status: 404 });
      }

      return net.fetch(pathToFileURL(audioPath).toString());
    } catch (err) {
      console.error('[Protocol: aln-recording] Error handling audio request:', err);
      return new Response('Access denied or invalid recording ID', { status: 403 });
    }
  });

  // Microphone permission: local only
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // System-audio capture (loopback)
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      }).catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopEngine);

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));

ipcMain.handle('engine:start', async (_e, model) => {
  if (engine && enginePort && engineModel === model) {
    return { port: enginePort, reused: true };
  }
  const port = await startEngine(model);
  return { port, reused: false };
});

ipcMain.handle('engine:stop', () => {
  stopEngine();
  return true;
});

ipcMain.handle('engine:status', () => ({
  running: Boolean(engine),
  port: enginePort,
  models: installedModels(),
  python: pythonExecutable(),
  platform: `${os.platform()} ${os.arch()}`,
}));

ipcMain.handle('agent:polish', async (_e, { text, config }) => {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: config.prompt },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Your agent replied ${response.status}. Check the endpoint in Settings.`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? '';
});

ipcMain.handle('file:saveTranscript', async (_e, { suggestedName, contents }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
});

ipcMain.handle('shell:openModels', () => {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  shell.openPath(MODELS_DIR);
});

// ---------------------------------------------------------------------------
// Storage & Recordings IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle('recordings:create', (_e, data) => recordingRepo.createRecording(data));
ipcMain.handle('recordings:appendAudioChunk', (_e, { id, buffer }) => recordingRepo.appendAudioChunk(id, buffer));
ipcMain.handle('recordings:appendSegment', (_e, { id, segment }) => recordingRepo.appendSegment(id, segment));
ipcMain.handle('recordings:saveNotes', (_e, { id, notes }) => recordingRepo.saveNotes(id, notes));
ipcMain.handle('recordings:addNote', (_e, { id, note }) => recordingRepo.addNote(id, note));
ipcMain.handle('recordings:updateMetadata', (_e, { id, patch }) => recordingRepo.updateMetadata(id, patch));
ipcMain.handle('recordings:finalize', (_e, { id, patch }) => recordingRepo.finalizeRecording(id, patch));
ipcMain.handle('recordings:get', (_e, { id }) => recordingRepo.getRecording(id));
ipcMain.handle('recordings:list', () => recordingRepo.listRecordings());
ipcMain.handle('recordings:delete', (_e, { id }) => recordingRepo.deleteRecording(id));
ipcMain.handle('recordings:rename', (_e, { id, title }) => recordingRepo.renameRecording(id, title));
ipcMain.handle('recordings:search', (_e, { query }) => recordingRepo.search(query));
ipcMain.handle('recordings:recoverIncomplete', () => recordingRepo.recoverIncomplete());
ipcMain.handle('recordings:openFolder', (_e, { id }) => {
  const p = storageManager.getRecordingPath(id);
  shell.openPath(p);
  return true;
});

ipcMain.handle('storage:getRoot', () => storageManager.getRoot());
ipcMain.handle('storage:openRoot', () => {
  shell.openPath(storageManager.getRecordingsRoot());
  return true;
});

// ---------------------------------------------------------------------------
// Google Drive Cloud Backup IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle('google:getStatus', () => googleAuth.getStatus());
ipcMain.handle('google:connect', () => googleAuth.startLoginFlow());
ipcMain.handle('google:disconnect', () => googleAuth.disconnect());
ipcMain.handle('google:backup', async (_e, { id }) => googleDriveClient.backupRecording(id));
ipcMain.handle('google:openFolder', (_e, { folderId }) => {
  const u = googleDriveClient.getFolderUrl(folderId);
  shell.openExternal(u);
  return true;
});
