// audio-analyzer.js — offline audio energy peak detection
// Extracts audio to raw PCM via ffmpeg, computes RMS per 50ms frame,
// finds segments where energy exceeds baseline by 3σ for >2s.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function findFfmpeg() {
  if (process.platform !== 'win32') return 'ffmpeg';
  const base = process.env.LOCALAPPDATA || '';
  const wingetDir = path.join(base, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(wingetDir)) {
      if (!d.startsWith('Gyan.FFmpeg')) continue;
      const pkgDir = path.join(wingetDir, d);
      for (const item of fs.readdirSync(pkgDir)) {
        if (!item.startsWith('ffmpeg-')) continue;
        const bin = path.join(pkgDir, item, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return 'ffmpeg';
}

const FFMPEG = findFfmpeg();

const SAMPLE_RATE = 16000;
const FRAME_MS = 50;
const FRAME_SAMPLES = Math.floor(SAMPLE_RATE * FRAME_MS / 1000); // 800
const FRAME_BYTES = FRAME_SAMPLES * 2;                            // 1600
const SIGMA_THRESHOLD = 3.0;
const MIN_PEAK_S = 2.0;
const MIN_PEAK_FRAMES = Math.ceil(MIN_PEAK_S * 1000 / FRAME_MS);  // 40
const MERGE_GAP_S = 2.0;
const MERGE_GAP_FRAMES = Math.ceil(MERGE_GAP_S * 1000 / FRAME_MS); // 40

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

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const frameDbArr = [];
    let pending = Buffer.alloc(0);
    let stderrLog = '';

    proc.stderr.on('data', (d) => { stderrLog += d.toString(); });

    proc.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      const completeFrames = Math.floor(pending.length / FRAME_BYTES);
      if (completeFrames === 0) return;

      const processLen = completeFrames * FRAME_BYTES;
      const toProcess = pending.subarray(0, processLen);
      pending = pending.subarray(processLen);

      for (let offset = 0; offset < processLen; offset += FRAME_BYTES) {
        frameDbArr.push(frameDb(toProcess, offset));
      }
    });

    proc.on('exit', (code) => {
      // Process any remaining partial frame
      if (pending.length >= FRAME_BYTES) {
        frameDbArr.push(frameDb(pending, 0));
      }

      if (code !== 0 && code !== null) {
        log.warn('[audio] ffmpeg exited ' + code + ': ' + stderrLog.slice(-200).trim());
      }

      if (frameDbArr.length === 0) {
        log.warn('[audio] No audio data from ' + path.basename(videoFilePath));
        resolve([]);
        return;
      }

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
        log.info('[audio] No peaks above threshold (mean=' + meanDb.toFixed(1) +
          ' dB, thresh=' + threshold.toFixed(1) + ' dB)');
        resolve([]);
        return;
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

      log.info('[audio] Analyzed ' + path.basename(videoFilePath) + ': ' +
        frameDbArr.length + ' frames, mean=' + meanDb.toFixed(1) +
        ' dB, thresh=' + threshold.toFixed(1) + ' dB, ' + peaks.length + ' peaks');
      resolve(peaks);
    });

    proc.on('error', (err) => {
      log.error('[audio] ffmpeg spawn error: ' + err.message);
      resolve([]);
    });
  });
}

module.exports = { analyzeAudio };
