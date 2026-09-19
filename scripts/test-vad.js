/* Exercises the utterance splitter without a browser:
 *     node scripts/test-vad.js
 *
 * It feeds synthetic audio (silence, speech, pauses) through the same code the
 * app uses and checks that sentences are cut where a person would cut them.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

const sandbox = {
  document: undefined,
  WebSocket: { OPEN: 1 },
  TextEncoder,
  console,
  setTimeout,
  Math,
  Blob: class {},
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  navigator: {},
  window: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8'), sandbox);

const { Channel, BLOCK_MS, SAMPLE_RATE } = sandbox.__internals;

// The module-level `settings` and `link` the Channel reads.
vm.runInContext(
  `settings = { silenceMs: 700, threshold: 0.012, maxUtteranceMs: 18000,
                speakerTask: 'translate', speakerLanguage: 'ar', showSource: false };`,
  sandbox
);

const sent = [];
vm.runInContext('link = { sendUtterance: (h, a) => globalThis.__sent(h, a) };', sandbox);
sandbox.__sent = (header, audio) => sent.push({ header, seconds: audio.length / SAMPLE_RATE });

const ui = {
  task: () => 'translate',
  language: () => 'ar',
  wantsSource: () => false,
  prompt: () => null,
  setLive() {}, setCapturing() {}, setLevel() {}, addPending() {},
};

const channel = new Channel('speaker', ui);

const BLOCK = 1024;
function block(amplitude) {
  const samples = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) samples[i] = (Math.random() * 2 - 1) * amplitude;
  const rms = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / BLOCK);
  return { samples, rms, peak: amplitude };
}

function feed(ms, amplitude) {
  const blocks = Math.round(ms / BLOCK_MS);
  for (let i = 0; i < blocks; i++) channel.onBlock(block(amplitude));
}

const QUIET = 0.002;
const VOICE = 0.09;

let failures = 0;
function check(label, condition, detail) {
  const mark = condition ? '  ok  ' : ' FAIL ';
  if (!condition) failures++;
  console.log(`[${mark}] ${label}${detail ? `  (${detail})` : ''}`);
}

// 1. Room tone alone must produce nothing.
feed(3000, QUIET);
check('silence produces no utterances', sent.length === 0, `got ${sent.length}`);

// 2. A sentence followed by a pause is emitted once.
feed(2500, VOICE);
feed(1200, QUIET);
check('one sentence becomes one utterance', sent.length === 1, `got ${sent.length}`);
if (sent[0]) {
  const s = sent[0].seconds;
  check('utterance includes pre-roll and the trailing pause', s > 2.5 && s < 4.2, `${s.toFixed(2)}s`);
}

// 3. Two sentences separated by a real pause become two utterances.
feed(1800, VOICE);
feed(1000, QUIET);
feed(1800, VOICE);
feed(1000, QUIET);
check('a pause splits sentences', sent.length === 3, `got ${sent.length}`);

// 4. A short pause mid-sentence must NOT split it.
const before = sent.length;
feed(1500, VOICE);
feed(300, QUIET);      // shorter than silenceMs
feed(1500, VOICE);
feed(1100, QUIET);
check('a breath does not split a sentence', sent.length === before + 1, `got ${sent.length - before}`);

// 5. A cough is discarded.
const beforeCough = sent.length;
feed(150, VOICE);
feed(1200, QUIET);
check('a very short noise is discarded', sent.length === beforeCough, `got ${sent.length - beforeCough}`);

// 6. Someone talking without pausing is cut on the clock.
const beforeLong = sent.length;
feed(40000, VOICE);
feed(1200, QUIET);
const chunks = sent.length - beforeLong;
check('continuous speech is cut into chunks', chunks >= 2, `${chunks} chunks from 40s`);
check('no chunk exceeds the ceiling', sent.slice(beforeLong).every((u) => u.seconds <= 19), '');

// 7. Header carries what the engine needs, including latency timestamps.
check('header names channel and task and includes latency timestamps',
  sent[0].header.channel === 'speaker' &&
  sent[0].header.task === 'translate' &&
  typeof sent[0].header.t_capture_start === 'number' &&
  typeof sent[0].header.t_vad_accepted === 'number', '');

// 8. Short conversational Arabic words (200ms voiced) are RETAINED (Loss-Minimizing VAD).
const beforeShort = sent.length;
feed(200, VOICE);
feed(1000, QUIET);
check('short conversational utterance (~200ms) is retained', sent.length === beforeShort + 1, `got ${sent.length - beforeShort}`);

// 9. Clamped noise floor does NOT run away above voice level during sustained room tone.
feed(10000, 0.018); // Elevated room tone
check('adaptive threshold remains clamped safely below 0.045', channel.threshold <= 0.045, `threshold = ${channel.threshold.toFixed(4)}`);

// 10. Voice immediately after elevated noise is still detected.
const beforeVoiceAfterNoise = sent.length;
feed(1500, VOICE);
feed(1000, QUIET);
check('voice after elevated noise floor is detected properly', sent.length === beforeVoiceAfterNoise + 1, `got ${sent.length - beforeVoiceAfterNoise}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
