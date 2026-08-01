// audio-analyzer.js — offline audio energy peak detection
// Extracts audio to raw PCM via ffmpeg, computes RMS per 50ms frame,
// finds segments where energy exceeds baseline by 3σ for >2s.

const { spawn } = require('child_process');
const path = require('path');
const { FFMPEG_BIN } = require('./recorder');

const SAMPLE_RATE = 16000;
const FRAME_MS = 50;
const FRAME_SAMPLES = Math.floor(SAMPLE_RATE * FRAME_MS / 1000); // 800
const FRAME_BYTES = FRAME_SAMPLES * 2;                            // 1600
const SIGMA_THRESHOLD = 3.0;
const MIN_PEAK_S = 2.0;
const MIN_PEAK_FRAMES = Math.ceil(MIN_PEAK_S * 1000 / FRAME_MS);  // 40
const MERGE_GAP_S = 2.0;
const MERGE_GAP_FRAMES = Math.ceil(MERGE_GAP_S * 1000 / FRAME_MS); // 40

// 每攒够 64 帧（3.2s 音频）统一处理一次，避免逐 chunk Buffer.concat 的 O(n²) 拷贝
const BATCH_FRAMES = 64;

function frameIndexToSeconds(idx) {
  return Math.round(idx * FRAME_MS) / 1000;
}

// Compute RMS for FRAME_BYTES of s16le PCM, return dBFS
function frameDb(buf, offset) {
  let sumSq = 0;
  const end = offset + FRAME_BYTES;
  for (let i = offset; i < end; i += 2) {
    const s = buf.readInt16LE(i);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / FRAME_SAMPLES);
  return rms > 1e-10 ? 20 * Math.log10(rms / 32768) : -90;
}

// 纯函数：从每帧 dB 数组中检出能量高峰段（便于单测）
function detectPeaks(frameDbArr, log) {
  if (frameDbArr.length === 0) return [];

  // ── Global baseline ──
  let sumDb = 0;
  for (const db of frameDbArr) sumDb += db;
  const meanDb = sumDb / frameDbArr.length;

  let sumSqDiff = 0;
  for (const db of frameDbArr) sumSqDiff += (db - meanDb) ** 2;
  const stdDb = Math.sqrt(sumSqDiff / frameDbArr.length);
  const threshold = meanDb + SIGMA_THRESHOLD * Math.max(stdDb, 0.5);

  // ── Find peak frames ──
  const peakFrames = [];
  for (let i = 0; i < frameDbArr.length; i++) {
    if (frameDbArr[i] > threshold) peakFrames.push(i);
  }

  if (peakFrames.length === 0) {
    if (log) log.info('[audio] No peaks above threshold (mean=' + meanDb.toFixed(1) +
      ' dB, thresh=' + threshold.toFixed(1) + ' dB)');
    return [];
  }

  // ── Group contiguous peak frames, merge gaps ≤ MERGE_GAP_FRAMES ──
  const segments = [];
  let segStart = peakFrames[0];
  let segEnd = peakFrames[0];

  for (let i = 1; i < peakFrames.length; i++) {
    if (peakFrames[i] - segEnd <= MERGE_GAP_FRAMES + 1) {
      segEnd = peakFrames[i];
    } else {
      segments.push({ start: segStart, end: segEnd });
      segStart = peakFrames[i];
      segEnd = peakFrames[i];
    }
  }
  segments.push({ start: segStart, end: segEnd });

  // ── Filter by min duration, compute maxDb ──
  const peaks = [];
  for (const seg of segments) {
    const frames = seg.end - seg.start + 1;
    if (frames < MIN_PEAK_FRAMES) continue;

    let maxDb = -Infinity;
    for (let i = seg.start; i <= seg.end; i++) {
      if (frameDbArr[i] > maxDb) maxDb = frameDbArr[i];
    }

    peaks.push({
      startOffset: frameIndexToSeconds(seg.start),
      endOffset: frameIndexToSeconds(seg.end + 1),
      maxDb: Math.round(maxDb * 10) / 10
    });
  }

  if (log) log.info('[audio] mean=' + meanDb.toFixed(1) + ' dB, thresh=' +
    threshold.toFixed(1) + ' dB, ' + peaks.length + ' peaks');
  return peaks;
}

async function analyzeAudio(videoFilePath, logger) {
  const log = logger || { info() {}, warn() {}, error() {} };

  return new Promise((resolve) => {
    const args = [
      '-i', videoFilePath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-acodec', 'pcm_s16le',
      '-f', 's16le',
      'pipe:1'
    ];

    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const frameDbArr = [];
    const chunks = [];
    let buffered = 0;
    let stderrLog = '';

    proc.stderr.on('data', (d) => {
      stderrLog += d.toString();
      if (stderrLog.length > 2000) stderrLog = stderrLog.slice(-1000);
    });

    // 把缓冲的 chunk 拼一次，切出所有完整帧处理掉，余量留到下一轮
    function drain(force) {
      if (!force && buffered < FRAME_BYTES * BATCH_FRAMES) return;
      if (buffered < FRAME_BYTES) return;
      const buf = Buffer.concat(chunks);
      const completeLen = Math.floor(buf.length / FRAME_BYTES) * FRAME_BYTES;
      for (let offset = 0; offset < completeLen; offset += FRAME_BYTES) {
        frameDbArr.push(frameDb(buf, offset));
      }
      chunks.length = 0;
      const rest = buf.subarray(completeLen);
      if (rest.length > 0) chunks.push(rest);
      buffered = rest.length;
    }

    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      buffered += chunk.length;
      drain(false);
    });

    proc.on('exit', (code) => {
      drain(true); // flush remaining frames

      if (code !== 0 && code !== null) {
        log.warn('[audio] ffmpeg exited ' + code + ': ' + stderrLog.slice(-200).trim());
      }

      if (frameDbArr.length === 0) {
        log.warn('[audio] No audio data from ' + path.basename(videoFilePath));
        resolve([]);
        return;
      }

      const peaks = detectPeaks(frameDbArr, log);
      log.info('[audio] Analyzed ' + path.basename(videoFilePath) + ': ' +
        frameDbArr.length + ' frames, ' + peaks.length + ' peaks');
      resolve(peaks);
    });

    proc.on('error', (err) => {
      log.error('[audio] ffmpeg spawn error: ' + err.message);
      resolve([]);
    });
  });
}

module.exports = { analyzeAudio, detectPeaks };
