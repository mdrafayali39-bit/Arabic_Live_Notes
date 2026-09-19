'use strict';

/**
 * Arabic Live Notes — Production Speech & Translation Pipeline
 * 
 * Key Architecture:
 * 1. Loss-Minimizing VAD and Boundary Preservation (rollover overlap at ceiling cuts, clamped noise floor).
 * 2. Strict Architectural Separation between Microphone (AEC, NS, AGC) and Loopback System Audio (raw).
 * 3. Immutable Captured Segment Store (Source of Truth): Captured Arabic speech segments are never overwritten or deleted by downstream failures.
 * 4. Bounded Downstream Translation & TTS Queues: Sequential execution, retry/backoff, safe backpressure.
 * 5. Sequential TTS Engine with Chromium SpeechSynthesis Hang Watchdog.
 * 6. End-to-End Latency Instrumentation across all 8 pipeline milestones.
 */

const SAMPLE_RATE = 16000;
const BLOCK_MS = 64;          // one worklet block (1024 samples @ 16 kHz)
const PREROLL_MS = 384;       // audio kept before speech is confirmed (6 blocks)
const MIN_VOICED_MS = 150;    // retain short conversational Arabic words ('نعم', 'لا', etc.)
const OVERLAP_BLOCKS = 6;     // 384ms rollover overlap for long continuous speech at ceiling
const MAX_NOISE_FLOOR = 0.020;// safe ceiling preventing noise floor runaway

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let settings = null;
let link = null;

// ---------------------------------------------------------------------------
// Audio Constraints: Strict separation between Mic and Loopback
// ---------------------------------------------------------------------------

const MIC_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

const LOOPBACK_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

let audioOutputMode = 'english'; // 'english' (TTS audible, original muted) | 'original' (original audio audible, TTS muted)

/**
 * Deduplicate word overlap between continuous speech chunks across 18s ceiling cuts.
 */
function deduplicateArabicOverlap(prevText, currentText) {
  if (!prevText || !currentText) return currentText;
  const prevWords = prevText.trim().split(/\s+/);
  const curWords = currentText.trim().split(/\s+/);
  if (prevWords.length === 0 || curWords.length === 0) return currentText;

  const maxCheck = Math.min(4, prevWords.length, curWords.length);
  for (let n = maxCheck; n >= 1; n--) {
    const prevSlice = prevWords.slice(-n).join(' ');
    const curSlice = curWords.slice(0, n).join(' ');
    if (prevSlice === curSlice) {
      return curWords.slice(n).join(' ');
    }
  }
  return currentText;
}

// ---------------------------------------------------------------------------
// Observability & Latency Instrumentation
// ---------------------------------------------------------------------------

class DiagnosticsLogger {
  constructor() {
    this.logs = [];
    this.maxLogs = 500;
    this.metrics = {
      vadSegments: 0,
      asrFinalized: 0,
      translationRequests: 0,
      translationSuccess: 0,
      translationFailures: 0,
      translationRetries: 0,
      ttsQueued: 0,
      ttsCompleted: 0,
      ttsFailures: 0,
      watchdogRecoveries: 0,
      recognitionRestarts: 0,
      duplicateEventsDetected: 0,
      latencies: [],
    };
    this.lastSegments = [];
  }

  inc(counter, val = 1) {
    if (typeof this.metrics[counter] === 'number') {
      this.metrics[counter] += val;
    }
  }

  recordLatency(ms) {
    if (typeof ms === 'number' && ms > 0) {
      this.metrics.latencies.push(ms);
      if (this.metrics.latencies.length > 500) this.metrics.latencies.shift();
    }
  }

  recordSegmentDebug(seg) {
    if (!seg) return;
    this.lastSegments.push({
      timestamp: new Date().toISOString(),
      ...seg,
    });
    if (this.lastSegments.length > 50) this.lastSegments.shift();
  }

  log(category, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      message,
      data,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    if (typeof window !== 'undefined' && window.__ALN_DEBUG) {
      console.log(`[ALN:${category}] ${message}`, data || '');
    }
  }

  getSummary() {
    const lats = this.metrics.latencies;
    const avgLatency = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
    const maxLatency = lats.length ? Math.max(...lats) : 0;
    const minLatency = lats.length ? Math.min(...lats) : 0;

    return {
      totalVADSegments: this.metrics.vadSegments,
      totalASRFinalized: this.metrics.asrFinalized,
      totalTranslationRequests: this.metrics.translationRequests,
      successfulTranslations: this.metrics.translationSuccess,
      failedTranslations: this.metrics.translationFailures,
      translationRetries: this.metrics.translationRetries,
      ttsItemsQueued: this.metrics.ttsQueued,
      ttsItemsCompleted: this.metrics.ttsCompleted,
      ttsFailures: this.metrics.ttsFailures,
      watchdogRecoveries: this.metrics.watchdogRecoveries,
      recognitionRestarts: this.metrics.recognitionRestarts,
      duplicateEventsDetected: this.metrics.duplicateEventsDetected,
      sourceSegmentsPreserved: typeof segmentStore !== 'undefined' ? segmentStore.getAllSegments().length : 0,
      latency: {
        averageMs: avgLatency,
        maxMs: maxLatency,
        minMs: minLatency,
        sampleCount: lats.length,
      },
    };
  }

  getLogs() {
    return this.logs;
  }
}

const diagnostics = new DiagnosticsLogger();

class LatencyTracker {
  static recordMilestone(segment, milestone) {
    if (!segment.latencies) segment.latencies = {};
    segment.latencies[milestone] = Date.now();
  }

  static calculateMetrics(latencies) {
    if (!latencies) return {};
    const l = latencies;
    return {
      vadMs: (l.t_vad_accepted && l.t_capture_start) ? Math.max(0, l.t_vad_accepted - l.t_capture_start) : null,
      asrMs: (l.t_asr_finalized && l.t_asr_start) ? Math.max(0, l.t_asr_finalized - l.t_asr_start) : null,
      translationMs: (l.t_translation_complete && l.t_translation_start) ? Math.max(0, l.t_translation_complete - l.t_translation_start) : null,
      ttsWaitMs: (l.t_tts_playback_start && l.t_tts_queued) ? Math.max(0, l.t_tts_playback_start - l.t_tts_queued) : null,
      ttsPlaybackMs: (l.t_tts_playback_complete && l.t_tts_playback_start) ? Math.max(0, l.t_tts_playback_complete - l.t_tts_playback_start) : null,
      totalE2EMs: (l.t_tts_playback_complete && l.t_capture_start)
        ? Math.max(0, l.t_tts_playback_complete - l.t_capture_start)
        : (l.t_asr_finalized && l.t_capture_start ? Math.max(0, l.t_asr_finalized - l.t_capture_start) : null),
    };
  }
}

// ---------------------------------------------------------------------------
// Immutable Captured Segment Store (Source of Truth)
// ---------------------------------------------------------------------------

class SegmentStore {
  constructor() {
    this.segments = new Map(); // id -> Segment
    this.order = [];           // Array of segment IDs
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, segment) {
    for (const listener of this.listeners) {
      try {
        listener(event, segment);
      } catch (err) {
        console.error('Error in SegmentStore listener:', err);
      }
    }
  }

  /**
   * Save a newly confirmed speech segment as the immutable source of truth.
   */
  addSegment(segment) {
    if (this.segments.has(segment.id)) {
      return this.updateSegment(segment.id, segment);
    }
    const record = {
      id: segment.id,
      channel: segment.channel || 'speaker',
      timestamp: segment.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      timestampMs: segment.timestampMs || Date.now(),
      audioDurationMs: segment.audioDurationMs || 0,
      sourceText: segment.sourceText || '',   // IMMUTABLE SOURCE OF TRUTH (Arabic speech)
      language: segment.language || 'ar',
      translatedText: segment.translatedText || '',
      task: segment.task || 'translate',
      state: segment.state || 'captured',    // 'captured'|'translating'|'translated'|'translation_failed'|'queued_tts'|'speaking'|'spoken'|'tts_failed'
      metadata: segment.metadata || {},
      latencies: segment.latencies || {},
    };

    this.segments.set(record.id, record);
    this.order.push(record.id);
    diagnostics.log('STORE', `Segment ${record.id} added to immutable store: "${record.sourceText}"`, { id: record.id });
    this.saveSessionBackup();
    this.notify('add', record);
    return record;
  }

  getSegment(id) {
    return this.segments.get(id) || null;
  }

  getAllSegments(channel = null) {
    return this.order
      .map((id) => this.segments.get(id))
      .filter((s) => Boolean(s) && (!channel || s.channel === channel));
  }

  /**
   * Downstream state update (translation, TTS status, error).
   * Note: The original sourceText is protected and will never be overwritten or emptied.
   */
  updateSegment(id, patch) {
    const existing = this.segments.get(id);
    if (!existing) return null;

    // Protect immutable Arabic source text: once captured, sourceText can never be altered or wiped
    const safePatch = { ...patch };
    if (existing.sourceText && Object.prototype.hasOwnProperty.call(safePatch, 'sourceText')) {
      delete safePatch.sourceText;
    }

    Object.assign(existing, safePatch);
    this.saveSessionBackup();
    this.notify('update', existing);
    return existing;
  }

  saveSessionBackup() {
    try {
      if (typeof localStorage !== 'undefined') {
        const backup = Array.from(this.segments.values());
        localStorage.setItem('aln_session_segments', JSON.stringify(backup));
      }
    } catch { /* storage quota or sandbox */ }
  }

  loadSessionBackup() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('aln_session_segments');
        if (raw) {
          const items = JSON.parse(raw);
          for (const it of items) this.addSegment(it);
          return items.length;
        }
      }
    } catch { /* ignore */ }
    return 0;
  }

  clear(channel = null) {
    if (!channel) {
      this.segments.clear();
      this.order = [];
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem('aln_session_segments');
      } catch { /* ignore */ }
    } else {
      this.order = this.order.filter((id) => {
        const s = this.segments.get(id);
        if (s && s.channel === channel) {
          this.segments.delete(id);
          return false;
        }
        return true;
      });
      this.saveSessionBackup();
    }
    this.notify('clear', { channel });
  }
}

const segmentStore = new SegmentStore();

// ---------------------------------------------------------------------------
// Connection to Python Speech Engine
// ---------------------------------------------------------------------------

class EngineLink {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.ready = false;
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => reject(new Error('The speech engine did not answer.')), 25000);

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ready') {
            clearTimeout(timer);
            this.ready = true;
            diagnostics.log('ENGINE', 'WebSocket connected and engine ready', msg);
            resolve(msg);
          }
          const handler = this.handlers.get(msg.type);
          if (handler) handler(msg);
        } catch (err) {
          console.error('Failed to parse engine message:', err);
        }
      };

      ws.onerror = (e) => {
        clearTimeout(timer);
        diagnostics.log('ENGINE', 'WebSocket error occurred', e);
        reject(new Error('Lost the connection to the speech engine.'));
      };

      ws.onclose = () => {
        this.ready = false;
        diagnostics.log('ENGINE', 'WebSocket closed');
        const handler = this.handlers.get('closed');
        if (handler) handler();
      };
    });
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  /** Ship one utterance: [uint32 LE header length][header JSON][int16 LE PCM]. */
  sendUtterance(header, float32) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const v = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    const frame = new ArrayBuffer(4 + headerBytes.length + pcm.byteLength);
    const view = new DataView(frame);
    view.setUint32(0, headerBytes.length, true);
    new Uint8Array(frame, 4, headerBytes.length).set(headerBytes);
    new Uint8Array(frame, 4 + headerBytes.length).set(new Uint8Array(pcm.buffer));

    this.ws.send(frame);
    diagnostics.log('ENGINE', `Sent utterance frame ${header.id} (${(float32.length / SAMPLE_RATE).toFixed(2)}s)`);
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.ready = false;
  }
}

// ---------------------------------------------------------------------------
// Loss-Minimizing VAD and Boundary Preservation Channel
// ---------------------------------------------------------------------------

class Channel {
  constructor(id, ui) {
    this.id = id;                    // 'speaker' | 'mine'
    this.ui = ui;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.active = false;

    this.prerollBlocks = Math.max(4, Math.round(PREROLL_MS / BLOCK_MS));
    this.preroll = [];               // Ring buffer of Float32Array

    this.collecting = null;          // Float32Array[] while speaking
    this.speechBlocks = 0;           // all buffered blocks in current utterance
    this.voicedBlocks = 0;           // count of blocks above speech threshold
    this.silenceBlocks = 0;
    this.onsetBlocks = 0;
    this.noiseFloor = 0.004;
    this.counter = 0;
    this.pending = 0;
    this.t_capture_start = 0;
  }

  get silenceBlocksNeeded() {
    const ms = (settings && settings.silenceMs) ? settings.silenceMs : 700;
    return Math.max(4, Math.round(ms / BLOCK_MS));
  }

  get maxSpeechBlocks() {
    const ms = (settings && settings.maxUtteranceMs) ? settings.maxUtteranceMs : 18000;
    return Math.round(ms / BLOCK_MS);
  }

  get threshold() {
    const base = (settings && settings.threshold) ? settings.threshold : 0.012;
    // Clamped adaptive noise floor: 1.8x multiplier capped at 0.045 to prevent runaway threshold
    return Math.min(0.045, Math.max(base, this.noiseFloor * 1.8));
  }

  async start(constraintsOrStream) {
    if (this.active) return;

    this.stream =
      constraintsOrStream instanceof MediaStream
        ? constraintsOrStream
        : await navigator.mediaDevices.getUserMedia(constraintsOrStream);

    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const blob = new Blob([window.CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    await this.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'capture-processor');
    this.node.port.onmessage = (event) => this.onBlock(event.data);
    source.connect(this.node);

    // Keep graph active without audible output from worklet node
    const sink = this.context.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.context.destination);

    // Audio Output Monitoring: allows user to hear original speaker audio when 'Original' is selected
    this.monitorGain = this.context.createGain();
    this.monitorGain.gain.value = (audioOutputMode === 'original' && this.id === 'speaker') ? 1.0 : 0.0;
    source.connect(this.monitorGain).connect(this.context.destination);

    this.active = true;
    this.ui.setLive(true);
    diagnostics.log('CAPTURE', `Channel ${this.id} started listening (monitor gain: ${this.monitorGain.gain.value})`);
  }

  async stop() {
    if (!this.active) return;
    this.flush(true, false);
    this.active = false;
    if (this.node) this.node.port.onmessage = null;
    if (this.monitorGain) {
      try { this.monitorGain.disconnect(); } catch {}
      this.monitorGain = null;
    }
    if (this.context) await this.context.close().catch(() => {});
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.context = null;
    this.stream = null;
    this.node = null;
    this.ui.setLive(false);
    this.ui.setLevel(0);
    diagnostics.log('CAPTURE', `Channel ${this.id} stopped listening`);
  }

  onBlock({ samples, rms, peak }) {
    this.ui.setLevel(peak);

    const speaking = rms > this.threshold;

    if (!speaking) {
      // Slowly learn room tone during quiet blocks only, clamped to MAX_NOISE_FLOOR
      this.noiseFloor = Math.min(MAX_NOISE_FLOOR, this.noiseFloor * 0.98 + rms * 0.02);
    }

    if (!this.collecting) {
      this.preroll.push(samples);
      if (this.preroll.length > this.prerollBlocks) this.preroll.shift();

      if (speaking) {
        this.onsetBlocks += 1;
        // Two consecutive voiced blocks confirm speech onset
        if (this.onsetBlocks >= 2) {
          this.collecting = this.preroll.slice();
          this.speechBlocks = this.preroll.length;
          this.voicedBlocks = 2;
          this.silenceBlocks = 0;
          this.onsetBlocks = 0;
          this.t_capture_start = Date.now() - (this.preroll.length * BLOCK_MS);
          this.ui.setCapturing(true);
          diagnostics.log('VAD', `Channel ${this.id} speech onset detected, initialized with ${this.preroll.length} pre-roll blocks`);
        }
      } else {
        this.onsetBlocks = 0;
      }
      return;
    }

    // Actively collecting speech
    this.collecting.push(samples);
    this.speechBlocks += 1;
    if (speaking) this.voicedBlocks += 1;
    this.silenceBlocks = speaking ? 0 : this.silenceBlocks + 1;

    if (this.silenceBlocks >= this.silenceBlocksNeeded) {
      // Natural sentence boundary detected by silence
      this.flush(false, false);
    } else if (this.speechBlocks >= this.maxSpeechBlocks) {
      // Continuous speech reached ceiling (e.g. 18s). Rollover with overlap so boundary words are preserved!
      this.flush(false, true);
    }
  }

  /**
   * Flush active speech buffer into an utterance.
   * @param {boolean} discard - Discard completely (e.g. on manual cancel).
   * @param {boolean} isCeilingCut - If true, seamlessly rollover the last window of speech to the next segment.
   */
  flush(discard, isCeilingCut) {
    if (!this.collecting) return;

    const blocks = this.collecting;
    const voicedMs = this.voicedBlocks * BLOCK_MS;
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const durationMs = (total / SAMPLE_RATE) * 1000;
    const t_vad_accepted = Date.now();
    const t_capture_start = this.t_capture_start || (t_vad_accepted - durationMs);

    // Boundary Preservation & State Reset
    if (isCeilingCut) {
      // Retain last OVERLAP_BLOCKS (~384ms) as the beginning of the next chunk
      const keepCount = Math.min(OVERLAP_BLOCKS, blocks.length);
      const overlap = blocks.slice(-keepCount);
      this.collecting = overlap.slice();
      this.speechBlocks = keepCount;
      this.voicedBlocks = keepCount;
      this.silenceBlocks = 0;
      this.t_capture_start = Date.now() - (keepCount * BLOCK_MS);
      diagnostics.log('VAD', `Channel ${this.id} ceiling reached; flushed segment and rolled over ${keepCount} overlap blocks`);
    } else {
      // Natural silence cut: retain trailing silence blocks in preroll ring-buffer for immediate speech resumption
      this.preroll = blocks.slice(-this.prerollBlocks);
      this.collecting = null;
      this.speechBlocks = 0;
      this.voicedBlocks = 0;
      this.silenceBlocks = 0;
      this.ui.setCapturing(false);
    }

    // Audio validation: discard coughs or below minimum voiced duration
    if (discard || voicedMs < MIN_VOICED_MS) {
      diagnostics.log('VAD', `Channel ${this.id} segment discarded (voiced: ${voicedMs}ms < ${MIN_VOICED_MS}ms)`);
      return;
    }

    const audio = new Float32Array(total);
    let offset = 0;
    for (const b of blocks) {
      audio.set(b, offset);
      offset += b.length;
    }

    const id = `${this.id}-${++this.counter}`;
    this.pending += 1;
    this.ui.addPending(id, durationMs);
    diagnostics.inc('vadSegments');

    if (link && (link.ready || typeof link.sendUtterance === 'function')) {
      link.sendUtterance(
        {
          id,
          channel: this.id,
          task: this.ui.task(),
          language: this.ui.language(),
          source: this.ui.wantsSource(),
          prompt: this.ui.prompt(),
          t_capture_start,
          t_vad_accepted,
        },
        audio
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sequential Text-to-Speech Engine with Hang Watchdog
// ---------------------------------------------------------------------------

class TTSQueue {
  constructor() {
    this.voices = [];
    this.queue = [];
    this.speaking = false;
    this.enabled = false;
    this.muted = false;
    this.watchdogTimer = null;
    this.lastSpokenText = '';
    this.lastSpokenTime = 0;
  }

  async load() {
    this.voices = await new Promise((resolve) => {
      const ready = speechSynthesis.getVoices();
      if (ready.length) return resolve(ready);
      const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 3000);
      speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timer);
          resolve(speechSynthesis.getVoices());
        },
        { once: true }
      );
    });
    return this.voices;
  }

  englishVoices() {
    return this.voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  }

  chosen() {
    const wanted = settings ? settings.voiceURI : '';
    return (
      this.voices.find((v) => v.voiceURI === wanted) ||
      this.englishVoices()[0] ||
      this.voices[0] ||
      null
    );
  }

  enqueue(text, lineId) {
    if (!this.enabled || !text || !text.trim()) return;

    // Deduplication check: avoid speaking duplicate identical phrases within 4s
    const now = Date.now();
    const cleanText = text.trim();
    if (cleanText === this.lastSpokenText && now - this.lastSpokenTime < 4000) {
      diagnostics.inc('duplicateEventsDetected');
      diagnostics.log('TTS', `Skipped duplicate phrase: "${cleanText}"`);
      return;
    }

    const item = {
      text: cleanText,
      lineId,
      t_tts_queued: now,
      retryCount: 0,
    };

    this.queue.push(item);
    diagnostics.inc('ttsQueued');
    diagnostics.log('TTS', `Enqueued utterance for ${lineId} (queue depth: ${this.queue.length})`);
    this.drain();
  }

  drain() {
    if (this.speaking || this.queue.length === 0) return;

    const item = this.queue.shift();
    const { text, lineId } = item;

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.chosen();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = (settings && settings.voiceRate) ? settings.voiceRate : 1.0;
    // Volume 0 when muted (e.g. Original Audio mode selected) to prevent TTS leaking into original audio
    utterance.volume = this.muted ? 0.0 : 1.0;

    this.speaking = true;
    item.t_tts_playback_start = Date.now();
    markSpoken(lineId, 'speaking');
    diagnostics.log('TTS', `Speaking ${lineId} (volume=${utterance.volume}): "${text}"`);

    // Hang Watchdog Timer: Chromium SpeechSynthesis can stall without firing onend/onerror.
    // Dynamic timeout based on word count + buffer.
    const wordCount = text.split(/\s+/).length;
    const timeoutMs = this.customWatchdogTimeoutMs || Math.max(4000, Math.round((wordCount * 600) / utterance.rate) + 3000);

    const clearWatchdog = () => {
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
    };

    const finish = (status) => {
      clearWatchdog();
      this.speaking = false;
      item.t_tts_playback_complete = Date.now();
      this.lastSpokenText = text;
      this.lastSpokenTime = Date.now();
      markSpoken(lineId, status);

      if (status === 'done') {
        diagnostics.inc('ttsCompleted');
      } else {
        diagnostics.inc('ttsFailures');
      }

      diagnostics.log('TTS', `Finished speaking ${lineId} (status: ${status})`);

      // Update segment store latency
      const seg = segmentStore.getSegment(lineId);
      if (seg && seg.latencies) {
        seg.latencies.t_tts_queued = item.t_tts_queued;
        seg.latencies.t_tts_playback_start = item.t_tts_playback_start;
        seg.latencies.t_tts_playback_complete = item.t_tts_playback_complete;
        const metrics = LatencyTracker.calculateMetrics(seg.latencies);
        if (metrics.totalE2EMs) diagnostics.recordLatency(metrics.totalE2EMs);
      }

      segmentStore.updateSegment(lineId, {
        state: status === 'done' ? 'spoken' : 'tts_failed',
      });

      // Advance to next in queue
      this.drain();
    };

    this.watchdogTimer = setTimeout(() => {
      diagnostics.inc('watchdogRecoveries');
      diagnostics.log('TTS', `Watchdog triggered for ${lineId} after ${timeoutMs}ms. Recovering.`);
      try {
        speechSynthesis.cancel();
      } catch (err) {
        console.error('speechSynthesis.cancel error:', err);
      }
      finish('done');
    }, timeoutMs);

    utterance.onend = () => finish('done');
    utterance.onerror = (e) => {
      diagnostics.log('TTS', `Utterance error for ${lineId}: ${e.error}`);
      finish('done'); // Gracefully advance on error
    };

    try {
      speechSynthesis.speak(utterance);
    } catch (err) {
      diagnostics.log('TTS', `speechSynthesis.speak throw: ${err.message}`);
      finish('done');
    }
  }

  getPendingCount() {
    return this.queue.length;
  }

  isIdle() {
    return !this.speaking && this.queue.length === 0;
  }

  drainPromise(timeoutMs = 60000) {
    return new Promise((resolve) => {
      if (this.isIdle()) return resolve(true);
      const start = Date.now();
      const interval = setInterval(() => {
        if (this.isIdle() || Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(this.isIdle());
        }
      }, 20);
    });
  }

  stop() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.queue = [];
    this.speaking = false;
    try {
      speechSynthesis.cancel();
    } catch { /* ignore */ }
    $$('#speaker-stream .is-speaking').forEach((el) => el.classList.remove('is-speaking'));
    diagnostics.log('TTS', 'TTS queue stopped and cancelled');
  }
}

const narrator = new TTSQueue();

function markSpoken(lineId, state) {
  const line = $(`#speaker-stream [data-id="${lineId}"]`);
  if (!line) return;
  line.classList.toggle('is-speaking', state === 'speaking');
}

// ---------------------------------------------------------------------------
// Reading stage UI (The other person: Arabic speech -> English notes)
// ---------------------------------------------------------------------------

const speakerUI = {
  stream: null,
  init() {
    this.stream = $('#speaker-stream');
  },
  task: () => (settings ? settings.speakerTask : 'translate'),
  language: () => (settings ? settings.speakerLanguage : 'ar'),
  wantsSource: () => (settings ? settings.showSource : false),
  prompt: () => '',

  setLive(on) {
    $('#speaker-dot').classList.toggle('is-live', on);
    $('#speaker-state').textContent = on ? 'Listening' : 'Stopped';
  },
  setCapturing(on) {
    $('#speaker-dot').classList.toggle('is-capturing', on);
  },
  setLevel(peak) {
    $('#speaker-level').style.setProperty('--level', Math.min(1, peak * 6).toFixed(3));
  },

  addPending(id, durationMs) {
    $('#speaker-empty')?.remove();
    let line = this.stream ? this.stream.querySelector(`[data-id="${id}"]`) : null;
    if (!line && this.stream) {
      line = document.createElement('article');
      line.className = 'line is-pending';
      line.dataset.id = id;
      line.innerHTML = `
        <time>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        <div class="line-body"><p class="english"><span class="working">Transcribing ${(durationMs / 1000).toFixed(1)}s…</span></p></div>`;
      this.stream.append(line);
    } else if (line) {
      line.className = 'line is-pending';
      const body = line.querySelector('.line-body') || line;
      body.innerHTML = `<p class="english"><span class="working">Transcribing ${(durationMs / 1000).toFixed(1)}s…</span></p>`;
    }
    this.scroll();
  },

  resolve(msg) {
    let line = this.stream ? this.stream.querySelector(`[data-id="${msg.id}"]`) : null;

    if (!msg.text && !msg.source) {
      // Utterance was pure silence / noise. Clean up pending element so it never leaves orphan "Transcribing Xs"
      if (line) line.remove();
      if (this.stream && this.stream.querySelectorAll('.line').length === 0) {
        if (!$('#speaker-empty')) {
          const empty = document.createElement('p');
          empty.className = 'empty';
          empty.id = 'speaker-empty';
          empty.textContent = 'Press start listening. Translated lines land here as the other person speaks.';
          this.stream.append(empty);
        }
      }
      return;
    }

    const t_asr_finalized = msg.t_asr_finalized || Date.now();
    diagnostics.inc('asrFinalized');
    if (this.task() === 'translate') {
      diagnostics.inc('translationRequests');
      if (msg.text) diagnostics.inc('translationSuccess');
    }

    const latencies = {
      t_capture_start: msg.t_capture_start,
      t_vad_accepted: msg.t_vad_accepted,
      t_asr_start: msg.t_asr_start,
      t_asr_finalized: t_asr_finalized,
    };

    if (latencies.t_capture_start && latencies.t_asr_finalized) {
      const e2e = Math.max(0, latencies.t_asr_finalized - latencies.t_capture_start);
      diagnostics.recordLatency(e2e);
    }

    let rawSource = msg.source || (this.task() === 'transcribe' ? msg.text : '');
    let rawTranslated = this.task() === 'translate' ? msg.text : '';

    // Overlap boundary deduplication against last speaker segment
    const lastSpeakerSeg = segmentStore.getAllSegments('speaker').slice(-1)[0];
    if (lastSpeakerSeg && lastSpeakerSeg.sourceText) {
      const dedupedSource = deduplicateArabicOverlap(lastSpeakerSeg.sourceText, rawSource);
      if (dedupedSource !== rawSource) {
        diagnostics.log('VAD', `Deduplicated overlap boundary: "${rawSource}" -> "${dedupedSource}"`);
        rawSource = dedupedSource;
      }
    }

    const sourceText = rawSource;
    const translatedText = rawTranslated;

    // Record segment in diagnostics logger debug ring buffer
    diagnostics.recordSegmentDebug({
      id: msg.id,
      channel: 'speaker',
      sourceText,
      translatedText,
      audioSeconds: msg.seconds,
      model: msg.model,
      device: msg.device,
      status: 'success',
    });

    // Store in immutable SegmentStore as source of truth
    segmentStore.addSegment({
      id: msg.id,
      channel: 'speaker',
      sourceText: sourceText,
      translatedText: translatedText,
      language: msg.language || 'ar',
      task: this.task(),
      audioDurationMs: (msg.seconds || 0) * 1000,
      state: 'captured',
      metadata: {
        seconds: msg.seconds,
        elapsed: msg.elapsed,
        asrLatencyMs: msg.asrLatencyMs,
        model: msg.model,
        device: msg.device,
      },
      latencies,
    });

    // Render in UI
    if (!line && this.stream) {
      line = document.createElement('article');
      line.className = 'line';
      line.dataset.id = msg.id;
      line.innerHTML = `
        <time>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        <div class="line-body"></div>`;
      this.stream.append(line);
    }

    if (line) {
      line.className = 'line'; // Clears is-pending and is-error
      const body = line.querySelector('.line-body') || line;
      body.innerHTML = '';

      const displayText = translatedText || sourceText || msg.text;
      const english = document.createElement('p');
      english.className = 'english';
      english.textContent = displayText;
      body.append(english);

      // If original Arabic source is available, render under English
      if (sourceText && (sourceText !== displayText || (settings && settings.showSource))) {
        const source = document.createElement('p');
        source.className = 'source';
        source.dir = 'rtl';
        source.lang = msg.language || 'ar';
        source.textContent = sourceText;
        body.append(source);
      }
    }

    // Read aloud in English if enabled and text is English
    if (this.task() === 'translate' && translatedText) {
      narrator.enqueue(translatedText, msg.id);
    }

    // Persist incrementally to active local recording session
    if (typeof recordingSession !== 'undefined' && recordingSession && recordingSession.isActive()) {
      const durMs = (msg.seconds || 0) * 1000;
      recordingSession.persistSegment({
        id: msg.id,
        sourceText: sourceText,
        translatedText: translatedText,
        language: msg.language || 'ar',
        task: this.task(),
        audioDurationMs: durMs,
        startOffset: recordingSession.getSegmentStartOffset(durMs),
        endOffset: recordingSession.getElapsedSeconds(),
        timestamp: new Date().toISOString(),
      });
    }

    this.scroll();
  },

  fail(msg) {
    diagnostics.inc('translationFailures');
    diagnostics.recordSegmentDebug({
      id: msg.id,
      channel: 'speaker',
      error: msg.message,
      status: 'error',
    });

    let line = this.stream ? this.stream.querySelector(`[data-id="${msg.id}"]`) : null;
    if (line) {
      line.className = 'line is-error';
      const body = line.querySelector('.line-body') || line;
      body.innerHTML = `<p class="english"><span class="hint-inline">${msg.message || 'Could not transcribe this segment — retrying…'}</span></p>`;
    }

    segmentStore.updateSegment(msg.id, {
      state: 'asr_failed',
      metadata: { error: msg.message },
    });
  },

  scroll() {
    if (!$('#speaker-follow').checked) return;
    this.stream.scrollTop = this.stream.scrollHeight;
  },

  text() {
    return segmentStore.getAllSegments('speaker')
      .map((s) => {
        const time = s.timestamp;
        const en = s.translatedText || s.sourceText;
        const ar = s.sourceText;
        return (ar && ar !== en) ? `[${time}] ${en}\n         ${ar}` : `[${time}] ${en}`;
      })
      .join('\n');
  },
};

// ---------------------------------------------------------------------------
// Dictation deck UI (My voice, written down)
// ---------------------------------------------------------------------------

const mineUI = {
  box: null,
  init() {
    this.box = $('#dictation');
  },
  task: () => (settings ? settings.myTask : 'translate'),
  language: () => (settings ? settings.myLanguage : 'ar'),
  wantsSource: () => false,
  prompt: () => null,

  setLive(on) {
    $('#mine-dot').classList.toggle('is-live', on);
    $('#mine-state').textContent = on ? 'Dictating' : 'Stopped';
    $('#mine-toggle').textContent = on ? 'Stop dictating' : 'Start dictating';
    $('#mine-toggle').classList.toggle('is-on', on);
  },
  setCapturing(on) {
    $('#mine-dot').classList.toggle('is-capturing', on);
  },
  setLevel(peak) {
    $('#mine-level').style.setProperty('--level', Math.min(1, peak * 6).toFixed(3));
  },

  addPending() {
    $('#mine-state').textContent = 'Writing it down';
  },

  resolve(msg) {
    $('#mine-state').textContent = 'Dictating';
    if (!msg.text) return;
    diagnostics.inc('asrFinalized');

    segmentStore.addSegment({
      id: msg.id,
      channel: 'mine',
      sourceText: msg.source || msg.text,
      translatedText: msg.text,
      language: msg.language || 'ar',
      task: this.task(),
      state: 'captured',
    });

    const existing = this.box.value.trimEnd();
    this.box.value = existing ? `${existing} ${msg.text}` : msg.text;
    this.box.scrollTop = this.box.scrollHeight;
    updateCount();
  },

  fail(msg) {
    $('#mine-state').textContent = msg.message;
  },
};

// ---------------------------------------------------------------------------
// Audio Channels Instances
// ---------------------------------------------------------------------------

const speaker = new Channel('speaker', speakerUI);
const mine = new Channel('mine', mineUI);

// ---------------------------------------------------------------------------
// Recording Session & Local Persistence Manager
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class RecordingSessionManager {
  constructor() {
    this.state = 'idle'; // 'idle' | 'preparing' | 'recording' | 'paused' | 'stopping' | 'finalizing' | 'complete' | 'recovered' | 'error'
    this.activeId = null;
    this.activeTitle = 'Untitled Lecture';
    this.isRecording = false;
    this.isPaused = false;
    this.elapsedSeconds = 0;
    this.timerInterval = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.notes = [];
    this.segmentSequence = 0;
  }

  isActive() {
    return this.isRecording && this.activeId !== null;
  }

  getElapsedSeconds() {
    return this.elapsedSeconds;
  }

  getSegmentStartOffset(durationMs) {
    const start = Math.max(0, this.elapsedSeconds - Math.round((durationMs || 0) / 1000));
    return start;
  }

  formatTime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  async start(stream, title = 'Classroom Lecture') {
    if (this.isRecording) return;
    this.state = 'preparing';
    this.activeTitle = title || 'Classroom Lecture';
    this.elapsedSeconds = 0;
    this.isPaused = false;
    this.notes = [];
    this.segmentSequence = 0;

    if (!window.bridge || !window.bridge.recordings) {
      console.warn('Recordings bridge not available. Running in memory-only mode.');
      this.isRecording = true;
      this.state = 'recording';
      this.startTimer();
      this.updateUI();
      return;
    }

    try {
      const rec = await window.bridge.recordings.create({
        title: this.activeTitle,
        speakerLanguage: settings ? settings.speakerLanguage : 'ar',
        outputLanguage: settings ? (settings.speakerTask === 'translate' ? 'en' : 'ar') : 'en',
        model: settings ? settings.model : 'small',
      });
      this.activeId = rec.id;
      this.isRecording = true;
      this.state = 'recording';

      // Setup incremental MediaRecorder audio capture
      if (stream && typeof MediaRecorder !== 'undefined') {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        
        this.mediaRecorder = new MediaRecorder(stream, { mimeType });
        this.mediaRecorder.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0 && this.activeId) {
            const arrayBuf = await e.data.arrayBuffer();
            window.bridge.recordings.appendAudio(this.activeId, arrayBuf).catch(err => {
              console.error('Failed to append incremental audio chunk:', err);
            });
          }
        };
        // Slice every 3 seconds for continuous crash-safe audio write
        this.mediaRecorder.start(3000);
      }
    } catch (err) {
      console.error('Failed to initialize persistent recording session:', err);
      this.state = 'error';
    }

    this.startTimer();
    this.updateUI();
  }

  startTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      if (!this.isPaused) {
        this.elapsedSeconds += 1;
        const timerEl = $('#rec-timer');
        if (timerEl) timerEl.textContent = this.formatTime(this.elapsedSeconds);
      }
    }, 1000);
  }

  pause() {
    if (!this.isRecording || this.isPaused) return;
    this.isPaused = true;
    this.state = 'paused';
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
    const pill = $('#rec-pill');
    const pillText = $('#rec-pill-text');
    const pauseBtn = $('#btn-rec-pause');
    if (pill) pill.classList.add('is-paused');
    if (pillText) pillText.textContent = 'PAUSED';
    if (pauseBtn) pauseBtn.textContent = 'Resume';
  }

  resume() {
    if (!this.isRecording || !this.isPaused) return;
    this.isPaused = false;
    this.state = 'recording';
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
    const pill = $('#rec-pill');
    const pillText = $('#rec-pill-text');
    const pauseBtn = $('#btn-rec-pause');
    if (pill) pill.classList.remove('is-paused');
    if (pillText) pillText.textContent = 'REC';
    if (pauseBtn) pauseBtn.textContent = 'Pause';
  }

  async persistSegment(seg) {
    if (!this.activeId || !window.bridge || !window.bridge.recordings) return;
    this.segmentSequence += 1;
    const startSec = typeof seg.startOffset === 'number' ? seg.startOffset : this.getSegmentStartOffset(seg.audioDurationMs);
    const endSec = typeof seg.endOffset === 'number' ? seg.endOffset : this.elapsedSeconds;
    
    // Diarization-ready Segment Data Model
    const segmentData = {
      ...seg,
      sequence: this.segmentSequence,
      startOffset: startSec,
      endOffset: endSec,
      speakerId: seg.speakerId || 'speaker-1',
      speakerLabel: seg.speakerLabel || 'Primary Speaker (Teacher)',
      speakerConfidence: typeof seg.speakerConfidence === 'number' ? seg.speakerConfidence : 1.0,
      speakerStart: typeof seg.speakerStart === 'number' ? seg.speakerStart : startSec,
      speakerEnd: typeof seg.speakerEnd === 'number' ? seg.speakerEnd : endSec,
    };

    try {
      await window.bridge.recordings.appendSegment(this.activeId, segmentData);
    } catch (err) {
      console.error('Error persisting segment:', err);
    }
  }

  async addNote(text) {
    if (!text || !text.trim()) return;
    const now = new Date();
    const formattedOffset = this.formatTime(this.elapsedSeconds).slice(3);
    const note = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      recordingId: this.activeId,
      createdAt: now.toISOString(),
      recordingOffset: formattedOffset,
      recordingOffsetSec: this.elapsedSeconds,
      text: text.trim(),
    };
    this.notes.push(note);
    if (this.activeId && window.bridge && window.bridge.recordings) {
      try {
        await window.bridge.recordings.addNote(this.activeId, note);
      } catch (err) {
        console.error('Error adding note to recording repository:', err);
      }
    }
    this.renderLiveNotes();
    return note;
  }

  renderLiveNotes() {
    const list = $('#live-notes-list');
    const countEl = $('#live-notes-count');
    if (countEl) countEl.textContent = `${this.notes.length} note${this.notes.length === 1 ? '' : 's'}`;
    if (!list) return;
    if (this.notes.length === 0) {
      list.innerHTML = '<p class="empty-notes" id="notes-empty-msg">Notes taken during the lecture will appear here with clickable timestamps.</p>';
      return;
    }
    list.innerHTML = this.notes.map(n => `
      <div class="note-card" data-id="${n.id}">
        <div class="note-card-head">
          <span class="note-time-btn" title="Recorded at ${n.recordingOffset}">⏱ ${n.recordingOffset}</span>
        </div>
        <div class="note-card-body">${escapeHtml(n.text)}</div>
      </div>
    `).join('');
  }

  async stop() {
    if (!this.isRecording) return;
    const recordingId = this.activeId;
    this.state = 'stopping';
    this.isRecording = false;
    this.isPaused = false;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch (e) {}
    }

    if (recordingId && window.bridge && window.bridge.recordings) {
      try {
        this.state = 'finalizing';
        await window.bridge.recordings.finalize(recordingId, {
          duration: this.elapsedSeconds,
          title: this.activeTitle,
        });
        this.state = 'complete';

        // Background Google Drive backup if connected
        if (window.bridge?.google?.getStatus) {
          const gStatus = await window.bridge.google.getStatus();
          if (gStatus && gStatus.connected && window.bridge.google.backupRecording) {
            window.bridge.google.backupRecording(recordingId).catch(err => {
              console.warn('Background Google Drive backup error:', err);
            });
          }
        }
      } catch (err) {
        console.error('Error finalizing recording:', err);
        this.state = 'error';
      }
    }

    this.activeId = null;
    this.updateUI();
  }

  updateUI() {
    const bar = $('#recording-bar');
    const titleEl = $('#rec-title-display');
    const timerEl = $('#rec-timer');
    if (this.isRecording) {
      if (bar) bar.hidden = false;
      if (titleEl) titleEl.textContent = this.activeTitle;
      if (timerEl) timerEl.textContent = this.formatTime(this.elapsedSeconds);
    } else {
      if (bar) bar.hidden = true;
    }
  }
}

const recordingSession = new RecordingSessionManager();

// ---------------------------------------------------------------------------
// View Router & UI State Management
// ---------------------------------------------------------------------------

const viewRouter = {
  activeView: 'home',
  currentDetailId: null,
  currentDetailData: null,
  cachedRecordings: [],
  pendingDeleteId: null,

  init() {
    // Nav Drawer Toggles
    $('#menu-toggle')?.addEventListener('click', () => this.toggleDrawer(true));
    $('#drawer-close')?.addEventListener('click', () => this.toggleDrawer(false));
    $('#drawer-backdrop')?.addEventListener('click', () => this.toggleDrawer(false));

    // Nav Links
    $$('.drawer-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        this.toggleDrawer(false);
        if (view === 'new-recording') {
          this.switchView('home');
          if (!speaker.active) toggleSpeaker();
        } else if (view === 'settings') {
          $('#settings')?.classList.add('is-open');
        } else {
          this.switchView(view);
        }
      });
    });

    $('#nav-history-btn')?.addEventListener('click', () => this.switchView('history'));
    $('#drawer-open-storage-btn')?.addEventListener('click', () => window.bridge.storage.openFolder('recordings'));
    $('#settings-close-btn')?.addEventListener('click', () => $('#settings')?.classList.remove('is-open'));

    // Recording Header Bar Controls
    $('#btn-rec-pause')?.addEventListener('click', () => {
      if (recordingSession.isPaused) recordingSession.resume();
      else recordingSession.pause();
    });
    $('#btn-rec-stop')?.addEventListener('click', async () => {
      if (speaker.active) await toggleSpeaker();
      else await recordingSession.stop();
    });

    // Live Note Composer
    $('#btn-add-live-note')?.addEventListener('click', () => this.addLiveNote());
    $('#live-note-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addLiveNote();
    });

    // History View Buttons
    $('#btn-history-refresh')?.addEventListener('click', () => this.loadHistory());
    $('#btn-history-new-rec')?.addEventListener('click', () => {
      this.switchView('home');
      if (!speaker.active) toggleSpeaker();
    });
    $('#history-search')?.addEventListener('input', (e) => this.filterHistory(e.target.value));

    // Detail View Buttons
    $('#btn-detail-back')?.addEventListener('click', () => this.switchView('history'));
    $('#btn-detail-backup')?.addEventListener('click', () => this.backupCurrentDetail());
    $('#btn-detail-open-drive')?.addEventListener('click', () => window.bridge.google.openDriveFolder());
    $('#btn-detail-export')?.addEventListener('click', () => this.exportCurrentDetail());
    $('#btn-detail-delete')?.addEventListener('click', () => this.promptDelete(this.currentDetailId));

    $('#btn-detail-add-note')?.addEventListener('click', () => this.addDetailNote());
    $('#detail-new-note-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addDetailNote();
    });

    // Delete Modal
    $('#modal-cancel-btn')?.addEventListener('click', () => $('#delete-modal')?.close());
    $('#modal-confirm-delete-btn')?.addEventListener('click', () => this.confirmDelete());

    // Audio Player in Detail View
    this.bindDetailPlayer();

    // Storage Settings
    this.bindStorageSettings();

    // Click outside settings to close
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('click', (e) => {
        const settingsEl = $('#settings');
        if (settingsEl && settingsEl.classList.contains('is-open')) {
          const isInside = settingsEl.contains(e.target);
          const isToggleBtn = e.target.closest && (e.target.closest('#settings-toggle') || e.target.closest('#drawer-settings-btn'));
          if (!isInside && !isToggleBtn) {
            settingsEl.classList.remove('is-open');
          }
        }
      });

      // Escape key closes settings, nav drawer, and modals
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          $('#settings')?.classList.remove('is-open');
          this.toggleDrawer(false);
          $('#delete-modal')?.close?.();
        }
      });
    }
  },

  toggleDrawer(open) {
    $('#nav-drawer')?.classList.toggle('is-open', open);
    $('#drawer-backdrop')?.classList.toggle('is-open', open);
  },

  switchView(viewName, params = {}) {
    this.activeView = viewName;
    $$('.view-pane').forEach(el => el.classList.remove('is-active'));
    $$('.drawer-link').forEach(el => el.classList.toggle('is-active', el.dataset.view === viewName));

    if (viewName === 'home') {
      $('#view-home')?.classList.add('is-active');
    } else if (viewName === 'history') {
      $('#view-history')?.classList.add('is-active');
      this.loadHistory();
    } else if (viewName === 'detail') {
      $('#view-detail')?.classList.add('is-active');
      if (params.id) this.loadDetail(params.id);
    }
  },

  async checkCrashRecovery() {
    if (!window.bridge || !window.bridge.recordings) return;
    try {
      const incomplete = await window.bridge.recordings.recoverIncomplete();
      if (incomplete && incomplete.length > 0) {
        const latest = incomplete[0];
        const banner = $('#crash-recovery-banner');
        if (banner) {
          banner.hidden = false;
          $('#recovery-title').textContent = latest.title || 'Unfinished Lecture';
          $('#recovery-meta').textContent = `• Duration: ~${latest.duration || 0}s • ${new Date(latest.createdAt).toLocaleString()}`;
          
          $('#btn-recover-open').onclick = () => {
            banner.hidden = true;
            this.switchView('detail', { id: latest.id });
          };
          $('#btn-recover-finalize').onclick = async () => {
            await window.bridge.recordings.finalize(latest.id, { duration: latest.duration });
            banner.hidden = true;
            status('Recovered recording saved to History.', 'ok');
          };
          $('#btn-recover-delete').onclick = async () => {
            await window.bridge.recordings.delete(latest.id);
            banner.hidden = true;
          };
        }
      }
    } catch (err) {
      console.warn('Crash recovery check error:', err);
    }
  },

  async loadHistory() {
    const listEl = $('#history-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="history-loading">Loading persistent recordings...</div>';

    if (!window.bridge || !window.bridge.recordings) {
      listEl.innerHTML = '<div class="history-empty">Recordings service not available.</div>';
      return;
    }

    try {
      this.cachedRecordings = await window.bridge.recordings.list();
      this.renderHistoryList(this.cachedRecordings);
    } catch (err) {
      listEl.innerHTML = `<div class="history-empty">Failed to load recordings: ${escapeHtml(err.message)}</div>`;
    }
  },

  filterHistory(query) {
    if (!query || !query.trim()) {
      this.renderHistoryList(this.cachedRecordings);
      return;
    }
    const q = query.trim().toLowerCase();
    const filtered = this.cachedRecordings.filter(r => 
      (r.title && r.title.toLowerCase().includes(q)) ||
      (r.speakerLanguage && r.speakerLanguage.toLowerCase().includes(q)) ||
      (r.id && r.id.toLowerCase().includes(q))
    );
    this.renderHistoryList(filtered);
  },

  renderHistoryList(recordings) {
    const listEl = $('#history-list');
    if (!listEl) return;
    if (!recordings || recordings.length === 0) {
      listEl.innerHTML = '<div class="history-empty">No classroom recordings found. Start a recording from the Live view to capture audio, transcripts, and notes.</div>';
      return;
    }

    listEl.innerHTML = recordings.map(r => {
      const dateStr = new Date(r.createdAt || Date.now()).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const durMin = Math.round((r.duration || 0) / 60);
      const durStr = durMin > 0 ? `${durMin} min` : `${r.duration || 0} sec`;

      const cloudStatusText = r.cloudBackupStatus === 'synced'
        ? '<span class="meta-pill is-cloud">Google Drive ✓</span>'
        : r.cloudBackupStatus === 'uploading'
        ? '<span class="meta-pill is-cloud">↻ Uploading</span>'
        : r.cloudBackupStatus === 'failed'
        ? '<span class="meta-pill">⚠ Cloud Failed</span>'
        : '<span class="meta-pill">Drive ○</span>';

      return `
        <div class="history-card" data-id="${r.id}">
          <div class="history-card-main">
            <h3 class="history-card-title">${escapeHtml(r.title)}</h3>
            <div class="history-meta-row">
              <span>📅 ${dateStr}</span>
              <span>⏱ ${durStr}</span>
              <span>🌐 ${r.speakerLanguage || 'ar'} → ${r.outputLanguage || 'en'}</span>
            </div>
            <div class="history-badges-row">
              <span class="meta-pill is-success">Local ✓</span>
              <span class="meta-pill">Transcript ✓ (${r.transcriptSegmentCount || 0})</span>
              <span class="meta-pill">English ✓</span>
              <span class="meta-pill">Notes: ${r.noteCount || 0}</span>
              ${cloudStatusText}
            </div>
          </div>
          <div class="history-card-actions">
            <button class="ghost sm btn-open-rec" data-id="${r.id}">Open</button>
            <button class="ghost sm btn-card-backup" data-id="${r.id}" title="Back up to Google Drive">☁️ Backup</button>
            <button class="ghost sm btn-danger btn-card-delete" data-id="${r.id}" title="Delete Recording">🗑</button>
          </div>
        </div>
      `;
    }).join('');

    // Bind action events
    listEl.querySelectorAll('.btn-open-rec').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchView('detail', { id: btn.dataset.id });
      });
    });

    listEl.querySelectorAll('.btn-card-backup').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.textContent = '↻ Syncing…';
        btn.disabled = true;
        await this.backupRecording(btn.dataset.id);
        btn.textContent = '☁️ Backup';
        btn.disabled = false;
      });
    });

    listEl.querySelectorAll('.btn-card-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.promptDelete(btn.dataset.id);
      });
    });

    listEl.querySelectorAll('.history-card').forEach(card => {
      card.addEventListener('click', () => {
        this.switchView('detail', { id: card.dataset.id });
      });
    });
  },

  async loadDetail(id) {
    this.currentDetailId = id;
    if (!window.bridge || !window.bridge.recordings) return;

    try {
      const rec = await window.bridge.recordings.get(id);
      if (!rec) {
        status('Recording not found.', 'error');
        this.switchView('history');
        return;
      }
      this.currentDetailData = rec;
      const { metadata, transcript, notes } = rec;

      // Update Header info
      $('#detail-title').textContent = metadata.title || 'Untitled Lecture';
      $('#detail-date').textContent = new Date(metadata.createdAt).toLocaleString();
      const durMin = Math.round((metadata.duration || 0) / 60);
      $('#detail-duration').textContent = durMin > 0 ? `${durMin} min` : `${metadata.duration || 0} sec`;
      $('#detail-lang').textContent = `${metadata.speakerLanguage || 'ar'} → ${metadata.outputLanguage || 'en'}`;

      const cloudStatusEl = $('#detail-cloud-status');
      if (cloudStatusEl) {
        cloudStatusEl.textContent = metadata.cloudBackupStatus === 'synced'
          ? 'Google Drive ✓'
          : 'Google Drive ○';
        cloudStatusEl.className = metadata.cloudBackupStatus === 'synced' ? 'meta-pill is-cloud' : 'meta-pill';
      }

      const openDriveBtn = $('#btn-detail-open-drive');
      if (openDriveBtn) {
        openDriveBtn.hidden = !(metadata.cloudFolderId || metadata.cloudBackupStatus === 'synced');
      }

      // Load Audio into custom protocol player
      const audioEl = $('#detail-audio');
      if (audioEl) {
        audioEl.src = `aln-recording://${encodeURIComponent(id)}/audio`;
        audioEl.load();
      }

      // Render Transcript & Notes
      this.renderDetailTranscript(transcript || []);
      this.renderDetailNotes(notes || []);
    } catch (err) {
      console.error('Failed to load recording detail:', err);
      status(`Failed to load recording: ${err.message}`, 'error');
    }
  },

  renderDetailTranscript(segments) {
    const list = $('#detail-transcript-list');
    if (!list) return;
    if (!segments || segments.length === 0) {
      list.innerHTML = '<p class="empty">No transcript segments recorded for this session.</p>';
      return;
    }

    list.innerHTML = segments.map(seg => {
      const sec = Math.floor(seg.startOffset || 0);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      const en = seg.translatedText || seg.sourceText || '';
      const ar = seg.sourceText || '';

      return `
        <div class="detail-segment-item" data-start="${seg.startOffset || 0}" data-end="${seg.endOffset || (seg.startOffset + 5)}">
          <span class="seg-time">⏱ ${timeStr}</span>
          <p class="english" style="margin: 0 0 4px; font-size: 15px; color: var(--paper);">${escapeHtml(en)}</p>
          ${ar && ar !== en ? `<p class="source" dir="rtl" style="margin: 0; font-size: 13.5px; color: var(--them);">${escapeHtml(ar)}</p>` : ''}
        </div>
      `;
    }).join('');

    // Clicking segment seeks audio
    list.querySelectorAll('.detail-segment-item').forEach(item => {
      item.addEventListener('click', () => {
        const start = parseFloat(item.dataset.start);
        const audio = $('#detail-audio');
        if (audio && !isNaN(start)) {
          audio.currentTime = start;
          audio.play().catch(() => {});
        }
      });
    });
  },

  renderDetailNotes(notes) {
    const list = $('#detail-notes-list');
    const countEl = $('#detail-notes-count');
    if (countEl) countEl.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
    if (!list) return;
    if (!notes || notes.length === 0) {
      list.innerHTML = '<p class="empty">No notes recorded for this lecture.</p>';
      return;
    }

    list.innerHTML = notes.map(n => `
      <div class="note-card" data-id="${n.id}">
        <div class="note-card-head">
          <button class="note-time-btn" data-time="${n.recordingOffsetSec || 0}">⏱ ${n.recordingOffset || '00:00'}</button>
        </div>
        <div class="note-card-body">${escapeHtml(n.text)}</div>
      </div>
    `).join('');

    // Seek on note click
    list.querySelectorAll('.note-time-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const time = parseFloat(btn.dataset.time);
        const audio = $('#detail-audio');
        if (audio && !isNaN(time)) {
          audio.currentTime = time;
          audio.play().catch(() => {});
        }
      });
    });
  },

  bindDetailPlayer() {
    const audio = $('#detail-audio');
    const playBtn = $('#btn-audio-play-pause');
    const timeDisplay = $('#player-time-display');
    const seeker = $('#player-progress');
    if (!audio) return;

    playBtn?.addEventListener('click', () => {
      if (audio.paused) {
        audio.play().catch(e => console.warn('Audio play error:', e));
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', () => {
      if (playBtn) playBtn.textContent = '⏸ Pause';
    });

    audio.addEventListener('pause', () => {
      if (playBtn) playBtn.textContent = '▶ Play';
    });

    audio.addEventListener('timeupdate', () => {
      const cur = audio.currentTime || 0;
      const dur = audio.duration || 0;
      if (timeDisplay) {
        const curM = Math.floor(cur / 60);
        const curS = Math.floor(cur % 60);
        const durM = Math.floor(dur / 60);
        const durS = Math.floor(dur % 60);
        timeDisplay.textContent = `${String(curM).padStart(2, '0')}:${String(curS).padStart(2, '0')} / ${String(durM).padStart(2, '0')}:${String(durS).padStart(2, '0')}`;
      }
      if (seeker && dur > 0) {
        seeker.value = (cur / dur) * 100;
      }

      // Highlight active segment in transcript
      $$('.detail-segment-item').forEach(el => {
        const start = parseFloat(el.dataset.start);
        const end = parseFloat(el.dataset.end);
        const isCurrent = cur >= start && cur <= end;
        el.classList.toggle('is-playing-segment', isCurrent);
      });
    });

    seeker?.addEventListener('input', () => {
      if (audio.duration) {
        audio.currentTime = (parseFloat(seeker.value) / 100) * audio.duration;
      }
    });

    // Playback Speed buttons
    $$('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.speed-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        audio.playbackRate = parseFloat(btn.dataset.speed);
      });
    });
  },

  async addLiveNote() {
    const input = $('#live-note-input');
    if (!input || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = '';
    await recordingSession.addNote(text);
  },

  async addDetailNote() {
    const input = $('#detail-new-note-input');
    if (!input || !input.value.trim() || !this.currentDetailId) return;
    const text = input.value.trim();
    input.value = '';

    const audio = $('#detail-audio');
    const curSec = audio ? Math.floor(audio.currentTime) : 0;
    const m = Math.floor(curSec / 60);
    const s = curSec % 60;
    const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    const note = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      recordingId: this.currentDetailId,
      createdAt: new Date().toISOString(),
      recordingOffset: formatted,
      recordingOffsetSec: curSec,
      text,
    };

    if (window.bridge && window.bridge.recordings) {
      await window.bridge.recordings.addNote(this.currentDetailId, note);
      await this.loadDetail(this.currentDetailId);
    }
  },

  promptDelete(id) {
    if (!id) return;
    this.pendingDeleteId = id;
    const rec = this.cachedRecordings.find(r => r.id === id) || (this.currentDetailData && this.currentDetailData.metadata);
    const cloudGroup = $('#modal-cloud-delete-group');
    if (cloudGroup) {
      cloudGroup.hidden = !(rec && (rec.cloudFolderId || rec.cloudBackupStatus === 'synced'));
    }
    const check = $('#modal-cloud-delete-check');
    if (check) check.checked = false;
    const modal = $('#delete-modal');
    if (modal) modal.showModal();
  },

  async confirmDelete() {
    const id = this.pendingDeleteId;
    if (!id || !window.bridge || !window.bridge.recordings) return;
    const deleteCloud = $('#modal-cloud-delete-check')?.checked || false;
    $('#delete-modal')?.close();

    try {
      await window.bridge.recordings.delete(id, { deleteCloud });
      status('Recording deleted.', 'ok');
      if (this.activeView === 'detail' && this.currentDetailId === id) {
        this.switchView('history');
      } else {
        await this.loadHistory();
      }
    } catch (err) {
      status(`Failed to delete: ${err.message}`, 'error');
    } finally {
      this.pendingDeleteId = null;
    }
  },

  async backupRecording(id) {
    if (!id || !window.bridge || !window.bridge.google) return;
    try {
      status('Starting Google Drive backup…', 'busy');
      const res = await window.bridge.google.backupRecording(id);
      status(`Backed up to Google Drive (folder: ${res.folderId || 'synced'})`, 'ok');
      if (this.activeView === 'history') await this.loadHistory();
      if (this.activeView === 'detail' && this.currentDetailId === id) await this.loadDetail(id);
    } catch (err) {
      status(`Google Drive backup failed: ${err.message}`, 'warn');
    }
  },

  async backupCurrentDetail() {
    if (this.currentDetailId) {
      await this.backupRecording(this.currentDetailId);
    }
  },

  async exportCurrentDetail() {
    if (!this.currentDetailData) return;
    const { metadata, transcript, notes } = this.currentDetailData;
    const exportData = {
      metadata,
      transcript,
      notes,
      exportedAt: new Date().toISOString(),
    };
    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${metadata.title || 'recording'}-${metadata.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    status('Recording exported as JSON.', 'ok');
  },

  async bindStorageSettings() {
    if (!window.bridge) return;

    // Local Storage Path
    try {
      if (window.bridge?.storage?.getRoot) {
        const rootPath = await window.bridge.storage.getRoot();
        const pathEl = $('#settings-storage-path');
        if (pathEl) pathEl.textContent = rootPath;
      }
    } catch (err) {}

    $('#btn-settings-open-storage')?.addEventListener('click', () => {
      window.bridge?.storage?.openFolder?.('recordings');
    });

    // Google Drive Connect / Disconnect
    const updateGDriveUI = async () => {
      try {
        if (!window.bridge?.google?.getStatus) return;
        const gStatus = await window.bridge.google.getStatus();
        const badge = $('#settings-gdrive-badge');
        const drawerBadge = $('#drawer-gdrive-status');
        const disPane = $('#gdrive-disconnected-pane');
        const conPane = $('#gdrive-connected-pane');
        const emailEl = $('#settings-gdrive-email');

        if (gStatus && gStatus.connected) {
          if (badge) {
            badge.textContent = '● Enabled';
            badge.className = 'status-badge is-ok';
          }
          if (drawerBadge) {
            drawerBadge.textContent = '● Connected';
            drawerBadge.className = 'storage-val is-ok';
          }
          if (disPane) disPane.hidden = true;
          if (conPane) conPane.hidden = false;
          if (emailEl) emailEl.textContent = gStatus.email || 'Google Account Connected';
        } else {
          if (badge) {
            badge.textContent = '○ Disabled';
            badge.className = 'status-badge';
          }
          if (drawerBadge) {
            drawerBadge.textContent = '○ Disabled';
            drawerBadge.className = 'storage-val';
          }
          if (disPane) disPane.hidden = false;
          if (conPane) conPane.hidden = true;
        }
      } catch (err) {
        console.warn('Failed to update Google Drive status:', err);
      }
    };

    await updateGDriveUI();

    $('#btn-settings-connect-gdrive')?.addEventListener('click', async () => {
      try {
        status('Opening system browser for Google authentication…', 'busy');
        const res = await window.bridge.google.connect();
        if (res && res.success) {
          status(`Connected to Google Drive as ${res.email || 'authorized user'}`, 'ok');
          await updateGDriveUI();
        }
      } catch (err) {
        status(`Google authorization failed: ${err.message}`, 'error');
      }
    });

    $('#btn-settings-disconnect-gdrive')?.addEventListener('click', async () => {
      try {
        await window.bridge.google.disconnect();
        status('Google Drive disconnected. Local recordings preserved.', 'ok');
        await updateGDriveUI();
      } catch (err) {
        status(`Disconnect error: ${err.message}`, 'error');
      }
    });

    $('#btn-settings-open-drive')?.addEventListener('click', () => {
      window.bridge.google.openDriveFolder();
    });
  },
};

function updateCount() {
  const words = $('#dictation').value.trim().split(/\s+/).filter(Boolean).length;
  $('#mine-count').textContent = words === 1 ? '1 word' : `${words} words`;
}

function status(text, tone = 'idle') {
  const el = $('#status');
  el.textContent = text;
  el.dataset.tone = tone;
}

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    for (const select of [$('#speaker-device'), $('#mine-device')]) {
      const current = select.value;
      select.innerHTML = '';
      if (select.id === 'speaker-device') {
        const loop = document.createElement('option');
        loop.value = 'loopback';
        loop.textContent = 'Computer sound (meeting audio)';
        select.append(loop);
      }
      for (const d of inputs) {
        const option = document.createElement('option');
        option.value = d.deviceId;
        option.textContent = d.label || 'Microphone';
        select.append(option);
      }
      if (inputs.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Default microphone';
        select.append(option);
      }
      if (current && Array.from(select.options).some((o) => o.value === current)) {
        select.value = current;
      }
    }
  } catch (err) {
    console.error('listDevices error:', err);
  }
}

/** Microphone constraints with AEC, NS, AGC enabled */
function micConstraints(deviceId) {
  return {
    audio: deviceId
      ? { deviceId: { exact: deviceId }, ...MIC_AUDIO_CONSTRAINTS }
      : { ...MIC_AUDIO_CONSTRAINTS },
  };
}

/** Speaker stream selector: loopback (raw) vs microphone */
async function speakerStream() {
  if ($('#speaker-device').value === 'loopback') {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      throw new Error('No computer sound was shared. Pick a microphone instead, or route the meeting into an input device.');
    }
    return stream;
  }
  return micConstraints($('#speaker-device').value);
}

let loadedModel = null;

async function ensureEngine() {
  if (link && link.ready && loadedModel === settings.model) return;

  if (link) link.close();
  status(`Loading the ${settings.model} model. The first run takes a minute.`, 'busy');
  const { port } = await window.bridge.startEngine(settings.model);
  link = new EngineLink();
  const info = await link.connect(port);
  loadedModel = settings.model;

  link.on('result', (msg) => {
    (msg.channel === 'speaker' ? speakerUI : mineUI).resolve(msg);
  });
  link.on('error', (msg) => {
    (msg.channel === 'speaker' ? speakerUI : mineUI).fail(msg);
  });
  link.on('closed', () => status('The speech engine stopped.', 'error'));

  const where = info.device === 'cuda' ? 'your graphics card' : 'the processor';
  status(`Running ${info.model} on ${where}.`, 'ok');
  if (info.weakAtTranslation && settings.speakerTask === 'translate') {
    status(`${info.model} is poor at translating into English. Switch to small, medium or large-v3 in Settings.`, 'warn');
  }
}

async function toggleSpeaker() {
  const button = $('#speaker-toggle');
  if (speaker.active) {
    await speaker.stop();
    if (typeof recordingSession !== 'undefined' && recordingSession.isActive()) {
      await recordingSession.stop();
    }
    button.textContent = 'Start listening';
    button.classList.remove('is-on');
    return;
  }
  try {
    button.disabled = true;
    await ensureEngine();
    const stream = await speakerStream();
    await speaker.start(stream);
    if (speaker.stream && typeof recordingSession !== 'undefined') {
      const stamp = new Date().toISOString().slice(0, 10);
      await recordingSession.start(speaker.stream, `Arabic Lecture - ${stamp}`);
    }
    await listDevices();
    button.textContent = 'Stop listening';
    button.classList.add('is-on');
  } catch (err) {
    status(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function toggleMine() {
  if (mine.active) {
    await mine.stop();
    return;
  }
  try {
    $('#mine-toggle').disabled = true;
    await ensureEngine();
    await mine.start(micConstraints($('#mine-device').value));
    await listDevices();
  } catch (err) {
    status(err.message, 'error');
  } finally {
    $('#mine-toggle').disabled = false;
  }
}

async function copy(text, button) {
  if (!text.trim()) return;
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = original), 1400);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function bindSettings() {
  const map = {
    '#set-model': 'model',
    '#set-speaker-language': 'speakerLanguage',
    '#set-speaker-task': 'speakerTask',
    '#set-my-language': 'myLanguage',
    '#set-my-task': 'myTask',
    '#set-silence': 'silenceMs',
    '#set-threshold': 'threshold',
  };

  for (const [sel, key] of Object.entries(map)) {
    const el = $(sel);
    if (!el) continue;
    el.value = settings[key];
    el.addEventListener('change', async () => {
      const value = el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
      settings = await window.bridge.saveSettings({ [key]: value });
      if (key === 'model') {
        status('Model changed. Stop and start listening to load it.', 'warn');
      }
      reflectSettings();
    });
    if (el.type === 'range') {
      el.addEventListener('input', () => {
        settings[key] = Number(el.value);
        reflectSettings();
      });
    }
  }

  const showSource = $('#set-show-source');
  if (showSource) {
    showSource.checked = settings.showSource;
    showSource.addEventListener('change', async (e) => {
      settings = await window.bridge.saveSettings({ showSource: e.target.checked });
    });
  }

  for (const [sel, key] of Object.entries({
    '#agent-enabled': 'enabled',
    '#agent-url': 'url',
    '#agent-model': 'model',
    '#agent-key': 'apiKey',
    '#agent-prompt': 'prompt',
  })) {
    const el = $(sel);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = settings.agent[key];
    else el.value = settings.agent[key];
    el.addEventListener('change', async () => {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      settings = await window.bridge.saveSettings({
        agent: { ...settings.agent, [key]: value },
      });
      $('#polish').hidden = !settings.agent.enabled;
    });
  }
  if ($('#polish')) $('#polish').hidden = !settings.agent.enabled;
}

function reflectSettings() {
  const silenceVal = $('#silence-value');
  if (silenceVal) silenceVal.textContent = `${(settings.silenceMs / 1000).toFixed(2)}s`;
  const threshVal = $('#threshold-value');
  if (threshVal) threshVal.textContent = settings.threshold.toFixed(3);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  settings = await window.bridge.getSettings();
  speakerUI.init();
  mineUI.init();
  bindSettings();
  reflectSettings();

  const info = await window.bridge.engineStatus();
  if ($('#footer-note')) {
    $('#footer-note').textContent = info.models.length
      ? `Models ready: ${info.models.join(', ')}`
      : 'No model files yet. The first run downloads one into the models folder.';
  }

  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch { /* user can select device later */ }
  await listDevices();
  navigator.mediaDevices.addEventListener('devicechange', listDevices);

  // --- TTS narrator setup ---
  await narrator.load();
  const english = narrator.englishVoices();
  const voiceSelect = $('#set-voice');
  if (voiceSelect) {
    for (const v of english.length ? english : narrator.voices) {
      const option = document.createElement('option');
      option.value = v.voiceURI;
      option.textContent = `${v.name} (${v.lang})`;
      voiceSelect.append(option);
    }
    if (settings.voiceURI) voiceSelect.value = settings.voiceURI;
    voiceSelect.addEventListener('change', async () => {
      settings = await window.bridge.saveSettings({ voiceURI: voiceSelect.value });
    });
  }

  if (english.length === 0) {
    if ($('#voice-warning')) $('#voice-warning').hidden = false;
    if ($('#read-aloud')) $('#read-aloud').disabled = true;
  }

  const rate = $('#set-rate');
  if (rate) {
    rate.value = settings.voiceRate;
    const showRate = () => {
      const el = $('#rate-value');
      if (el) el.textContent = `${Number(rate.value).toFixed(2)}x`;
    };
    showRate();
    rate.addEventListener('input', () => { settings.voiceRate = Number(rate.value); showRate(); });
    rate.addEventListener('change', async () => {
      settings = await window.bridge.saveSettings({ voiceRate: Number(rate.value) });
    });
  }

  const readAloud = $('#read-aloud');
  if (readAloud) {
    readAloud.checked = settings.readAloud && english.length > 0;
    narrator.enabled = readAloud.checked;
    if ($('#stop-speaking')) $('#stop-speaking').hidden = !narrator.enabled;
    readAloud.addEventListener('change', async () => {
      narrator.enabled = readAloud.checked;
      if ($('#stop-speaking')) $('#stop-speaking').hidden = !narrator.enabled;
      if (!narrator.enabled) narrator.stop();
      settings = await window.bridge.saveSettings({ readAloud: readAloud.checked });
    });
  }
  if ($('#stop-speaking')) {
    $('#stop-speaking').addEventListener('click', () => narrator.stop());
  }

  function setAudioOutputMode(mode) {
    audioOutputMode = mode;
    $('#audio-opt-english')?.classList.toggle('is-active', mode === 'english');
    $('#audio-opt-original')?.classList.toggle('is-active', mode === 'original');
    if (speaker && speaker.monitorGain && speaker.context) {
      speaker.monitorGain.gain.setValueAtTime(mode === 'original' ? 1.0 : 0.0, speaker.context.currentTime);
    }
    if (narrator) {
      narrator.muted = (mode === 'original');
    }
    diagnostics.log('AUDIO', `Switched audio output monitoring mode to: ${mode}`);
  }

  $('#audio-opt-english')?.addEventListener('click', () => setAudioOutputMode('english'));
  $('#audio-opt-original')?.addEventListener('click', () => setAudioOutputMode('original'));

  $('#speaker-toggle')?.addEventListener('click', toggleSpeaker);
  $('#mine-toggle')?.addEventListener('click', toggleMine);

  $('#speaker-copy')?.addEventListener('click', (e) => copy(speakerUI.text(), e.target));
  $('#mine-copy')?.addEventListener('click', (e) => copy($('#dictation').value, e.target));

  $('#speaker-clear')?.addEventListener('click', () => {
    segmentStore.clear('speaker');
    $('#speaker-stream').innerHTML =
      '<p class="empty" id="speaker-empty">Press start listening. Translated lines land here as the other person speaks.</p>';
  });
  $('#mine-clear')?.addEventListener('click', () => {
    segmentStore.clear('mine');
    $('#dictation').value = '';
    updateCount();
  });

  $('#dictation')?.addEventListener('input', updateCount);

  $('#save')?.addEventListener('click', async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const body = `# Meeting notes ${stamp}\n\n## What was said\n\n${speakerUI.text()}\n\n## My notes\n\n${$('#dictation').value}\n`;
    const saved = await window.bridge.saveTranscript(`notes-${stamp}.md`, body);
    if (saved) status(`Saved to ${saved}`, 'ok');
  });

  $('#polish')?.addEventListener('click', async (e) => {
    const button = e.target;
    const text = speakerUI.text();
    if (!text.trim()) return;
    button.disabled = true;
    button.textContent = 'Asking your agent';
    try {
      const reply = await window.bridge.polish(text, settings.agent);
      $('#dictation').value = reply;
      updateCount();
      status('Your agent rewrote the transcript into the notes box.', 'ok');
    } catch (err) {
      status(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Polish with my agent';
    }
  });

  $('#settings-toggle')?.addEventListener('click', () => {
    $('#settings').classList.toggle('is-open');
  });
  $('#open-models')?.addEventListener('click', () => window.bridge.openModelsFolder());

  window.bridge.onEngineExit(({ code, log }) => {
    if (code === 0) return;
    status(`The speech engine stopped unexpectedly. ${log.slice(-1)[0] || ''}`, 'error');
    speaker.stop();
    mine.stop();
  });

  // Initialize View Router, History, Crash Recovery, and Storage UI
  viewRouter.init();
  await viewRouter.checkCrashRecovery();

  updateCount();
}

// Exposed for test harnesses
globalThis.__internals = {
  Channel,
  EngineLink,
  SegmentStore,
  segmentStore,
  TTSQueue,
  narrator,
  speakerUI,
  mineUI,
  LatencyTracker,
  diagnostics,
  audioOutputMode,
  deduplicateArabicOverlap,
  MIC_AUDIO_CONSTRAINTS,
  LOOPBACK_AUDIO_CONSTRAINTS,
  SAMPLE_RATE,
  BLOCK_MS,
  PREROLL_MS,
  MIN_VOICED_MS,
  OVERLAP_BLOCKS,
  recordingSession,
  RecordingSessionManager,
  viewRouter,
};

if (typeof document !== 'undefined') boot();
