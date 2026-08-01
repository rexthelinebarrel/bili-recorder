const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Store = require('./store');
const BiliAPI = require('./bili-api');

// ─── FFmpeg discovery ──────────────────────────────────────────────────────

function findTool(name) {
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
        const bin = path.join(pkgDir, item, 'bin', name + '.exe');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return null;
}

const logger = require('./logger');

const FFMPEG_BIN = findTool('ffmpeg') || 'ffmpeg';
// ffprobe 也要探测——之前用 path.dirname(FFMPEG_BIN) 推导，ffmpeg 来自 PATH 时会得到错误路径
const FFPROBE_BIN = findTool('ffprobe') || 'ffprobe';
logger.info(`ffmpeg: ${FFMPEG_BIN}, ffprobe: ${FFPROBE_BIN}`);

// ─── ffmpeg args builder ───────────────────────────────────────────────────

const FORMAT_EXTS = { mkv: 'mkv', ts: 'ts', mp4: 'mp4', flv: 'flv' };

function formatToExt(format) {
  return FORMAT_EXTS[format] || 'flv';
}

function getFfmpegArgs(streamUrl, filePath, format, quality) {
  const headers = 'Referer: https://live.bilibili.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n';
  const baseArgs = ['-headers', headers, '-i', streamUrl];
  const ext = formatToExt(format);
  switch (format) {
    case 'mkv':
    case 'ts':
      return { ext, args: [...baseArgs, '-c', 'copy', '-f', format === 'mkv' ? 'matroska' : 'mpegts', '-y', filePath] };
    case 'mp4': {
      const qMap = {
        auto:  { crf: '18', preset: 'medium' },
        high:  { crf: '20', preset: 'fast' },
        medium:{ crf: '23', preset: 'fast' },
        low:   { crf: '28', preset: 'ultrafast' }
      };
      const q = qMap[quality] || qMap.auto;
      // frag_keyframe+empty_moov: file stays playable even if ffmpeg is killed
      return { ext, args: [...baseArgs, '-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf, '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', '-y', filePath] };
    }
    default: // flv
      return { ext, args: [...baseArgs, '-c', 'copy', '-f', 'flv', '-y', filePath] };
  }
}

const VIDEO_EXTS = new Set(['.flv', '.mkv', '.ts', '.mp4']);

// ─── Recorder ──────────────────────────────────────────────────────────────

const Recorder = {
  _processes: {},
  _lastExitedFile: {},  // streamerId -> filePath (preserved after ffmpeg exits)
  _streamStartTime: {}, // streamerId -> first recording start timestamp (seconds)
  _segments: {},        // streamerId -> [{ filePath, startTs, endTs }] 录制分片表

  _ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  },

  // 分片表持久化在主播目录的 segments.json，供切片时做 墙钟时间→文件内偏移 映射
  _loadSegments(streamerId, dir) {
    if (this._segments[streamerId]) return this._segments[streamerId];
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'segments.json'), 'utf-8'));
      this._segments[streamerId] = Array.isArray(data.segments) ? data.segments : [];
    } catch {
      this._segments[streamerId] = [];
    }
    return this._segments[streamerId];
  },

  _saveSegments(streamerId) {
    const segs = this._segments[streamerId];
    if (!segs || segs.length === 0) return;
    try {
      const dir = path.dirname(segs[segs.length - 1].filePath);
      fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify({ segments: segs }, null, 2), 'utf-8');
    } catch {}
  },

  _endSegment(streamerId, filePath) {
    const segs = this._segments[streamerId];
    if (!segs) return;
    const seg = segs.find(s => s.filePath === filePath && s.endTs == null);
    if (seg) {
      seg.endTs = Date.now() / 1000;
      this._saveSegments(streamerId);
    }
  },

  async start(streamerId, roomId, streamerName) {
    if (this._processes[streamerId]) return;

    const streamer = Store.getStreamers().find(s => s.id === streamerId);
    const quality = (streamer && streamer.quality) || 'auto';
    const fmt = (streamer && streamer.format) || Store.getSettings().format || 'flv';
    const ext = formatToExt(fmt);

    const savePath = Store.getSettings().savePath;
    const dir = path.join(savePath, streamerName);
    this._ensureDir(dir);

    const safeName = streamerName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 30);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // 每次都录新分片文件。旧版"重连复用同一路径"会被 ffmpeg -y 截断覆盖，丢已录内容
    const filePath = path.join(dir, `${safeName}_${ts}.${ext}`);

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
          this._endSegment(streamerId, this._processes[streamerId].filePath);
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
        const segs = this._loadSegments(streamerId, dir);
        // 闭合所有未结束的历史分片（崩溃/强杀留下的 endTs=null），
        // 否则墙钟映射会把新高光错配到最早的开口分片
        for (const seg of segs) {
          if (seg.endTs == null) seg.endTs = Date.now() / 1000;
        }
        segs.push({ filePath, startTs: Date.now() / 1000, endTs: null });
        this._saveSegments(streamerId);
        if (!this._streamStartTime[streamerId]) {
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
    this._endSegment(streamerId, filePath);
    return filePath;
  },

  isRecording(streamerId) {
    return !!this._processes[streamerId];
  },

  isWritingTo(filePath) {
    return Object.values(this._processes).some(e => e.filePath === filePath);
  },

  activeIds() {
    return Object.keys(this._processes);
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

function isValidVideo(filePath) {
  const r = spawnSync(FFPROBE_BIN, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 10000 });
  return r.status === 0;
}

// 返回视频时长（秒），失败返回 null
function getVideoDuration(filePath) {
  const r = spawnSync(FFPROBE_BIN, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 10000 });
  if (r.status !== 0) return null;
  const d = parseFloat(String(r.stdout).trim());
  return isNaN(d) ? null : d;
}

module.exports = { Recorder, getFfmpegArgs, formatToExt, FFMPEG_BIN, FFPROBE_BIN, VIDEO_EXTS, isValidVideo, getVideoDuration };
