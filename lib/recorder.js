const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Store = require('./store');
const BiliAPI = require('./bili-api');

// ─── FFmpeg discovery ──────────────────────────────────────────────────────

function findFfmpegPath() {
  // Search winget install location on Windows
  if (process.platform !== 'win32') return null;
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
  return null;
}

const logger = require('./logger');

const FFMPEG_BIN = findFfmpegPath() || 'ffmpeg';
const FFPROBE_BIN = path.join(path.dirname(FFMPEG_BIN), 'ffprobe.exe');
logger.info(`ffmpeg: ${FFMPEG_BIN}`);

// ─── ffmpeg args builder ───────────────────────────────────────────────────

function getFfmpegArgs(streamUrl, filePath, format, quality) {
  const headers = 'Referer: https://live.bilibili.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n';
  const baseArgs = ['-headers', headers, '-i', streamUrl];
  switch (format) {
    case 'mkv':
      return { ext: 'mkv', args: [...baseArgs, '-c', 'copy', '-f', 'matroska', '-y', filePath] };
    case 'ts':
      return { ext: 'ts', args: [...baseArgs, '-c', 'copy', '-f', 'mpegts', '-y', filePath] };
    case 'mp4': {
      const qMap = {
        auto:  { crf: '18', preset: 'medium' },
        high:  { crf: '20', preset: 'fast' },
        medium:{ crf: '23', preset: 'fast' },
        low:   { crf: '28', preset: 'ultrafast' }
      };
      const q = qMap[quality] || qMap.auto;
      // frag_keyframe+empty_moov: file stays playable even if ffmpeg is killed
      return { ext: 'mp4', args: [...baseArgs, '-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf, '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', '-y', filePath] };
    }
    default: // flv
      return { ext: 'flv', args: [...baseArgs, '-c', 'copy', '-f', 'flv', '-y', filePath] };
  }
}

const VIDEO_EXTS = new Set(['.flv', '.mkv', '.ts', '.mp4']);

// ─── Recorder ──────────────────────────────────────────────────────────────

const Recorder = {
  _processes: {},
  _lastExitedFile: {},  // streamerId -> filePath (preserved after ffmpeg exits)
  _streamStartTime: {}, // streamerId -> first recording start timestamp (seconds)

  _ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  },

  async start(streamerId, roomId, streamerName, reusePath) {
    if (this._processes[streamerId]) return;

    const streamer = Store.getStreamers().find(s => s.id === streamerId);
    const quality = (streamer && streamer.quality) || 'auto';
    const fmt = (streamer && streamer.format) || Store.getSettings().format || 'flv';
    const { ext } = getFfmpegArgs('', '', fmt, quality);

    const savePath = Store.getSettings().savePath;
    const dir = path.join(savePath, streamerName);
    this._ensureDir(dir);

    const safeName = streamerName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 30);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = reusePath || path.join(dir, `${safeName}_${ts}.${ext}`);

    const streamUrl = await BiliAPI.getStreamUrl(roomId, quality);

    const { args } = getFfmpegArgs(streamUrl, filePath, fmt, quality);

    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderrLog = '';
      proc.stderr.on('data', (d) => {
        stderrLog += d.toString();
        if (stderrLog.length > 2000) stderrLog = stderrLog.slice(-1000);
      });

      let settled = false;
      let startupError = null;
      let exited = false;

      proc.on('error', (err) => {
        startupError = err;
        logger.error(`[recorder] ffmpeg spawn error for ${streamerName}: ${err.message}`);
        if (!settled) { settled = true; reject(err); }
      });

      proc.on('exit', (code) => {
        exited = true;
        if (this._processes[streamerId]) {
          logger.info(`[recorder] ffmpeg exited (code ${code}) for ${streamerName}`);
          this._lastExitedFile[streamerId] = this._processes[streamerId].filePath;
        }
        delete this._processes[streamerId];
        if (!settled) {
          settled = true;
          const detail = stderrLog ? ': ' + stderrLog.trim().split('\n').pop() : '';
          reject(new Error(`ffmpeg exited with code ${code} during startup${detail}`));
        }
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (exited || startupError) {
          reject(startupError || new Error('ffmpeg exited during startup'));
          return;
        }
        this._processes[streamerId] = {
          process: proc,
          filePath,
          startedAt: Date.now()
        };
        if (!reusePath || !this._streamStartTime[streamerId]) {
          this._streamStartTime[streamerId] = Date.now() / 1000;
        }
        resolve(filePath);
      }, 3000);
    });
  },

  getLastExitedFile(streamerId) {
    const p = this._lastExitedFile[streamerId];
    delete this._lastExitedFile[streamerId];
    return p || null;
  },

  async stop(streamerId) {
    const entry = this._processes[streamerId];
    if (!entry) return null;
    const { process: proc, filePath } = entry;
    delete this._processes[streamerId];
    delete this._lastExitedFile[streamerId];
    delete this._streamStartTime[streamerId];
    try { proc.stdin.write('q'); } catch {}
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);
      proc.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    return filePath;
  },

  isRecording(streamerId) {
    return !!this._processes[streamerId];
  },

  getStreamStartTime(streamerId) {
    return this._streamStartTime[streamerId] || null;
  },

  getRecordingInfo(streamerId) {
    const entry = this._processes[streamerId];
    if (!entry) return null;
    return {
      filePath: entry.filePath,
      startedAt: entry.startedAt,
      duration: Math.floor((Date.now() - entry.startedAt) / 1000)
    };
  }
};

// ─── Source file helpers ───────────────────────────────────────────────────

function isValidMP4(filePath) {
  const r = spawnSync(FFPROBE_BIN, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 10000 });
  return r.status === 0;
}

function findBestSourceFile(streamerName) {
  const dir = path.join(Store.getSettings().savePath, streamerName);
  let bestFile = null;
  let bestScore = 0;
  try {
    if (!fs.existsSync(dir)) return null;
    const todayStr = new Date().toISOString().slice(0, 10);
    const files = fs.readdirSync(dir);
    const candidates = [];
    for (const f of files) {
      if (!f.endsWith('.mp4') || f.includes('_clip_')) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        const isToday = f.includes(todayStr);
        candidates.push({ fp, score: st.size * (isToday ? 10 : 1) });
      } catch {}
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (c.score > 50 * 1024 * 1024 && isValidMP4(c.fp)) {
        bestFile = c.fp; bestScore = c.score; break;
      }
    }
  } catch {}
  return (bestFile && bestScore > 50 * 1024 * 1024) ? bestFile : null;
}

module.exports = { Recorder, getFfmpegArgs, FFMPEG_BIN, FFPROBE_BIN, VIDEO_EXTS, isValidMP4, findBestSourceFile };
