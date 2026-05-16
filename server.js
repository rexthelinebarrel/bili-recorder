const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');
const { createDanmakuParser } = require('./lib/danmaku-parser');
const { createHighlightEngine } = require('./lib/highlight-engine');
const { HighlightStore } = require('./lib/highlight-store');
const { analyzeAudio } = require('./lib/audio-analyzer');

// ─── Logger ──────────────────────────────────────────────────────────────────
const LOG_PATH = path.join(__dirname, 'app.log');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  _write(level, msg) {
    const line = `[${timestamp()}] ${level} ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8'); } catch {}
  },
  info(msg) { this._write('INFO', msg); },
  warn(msg) { this._write('WARN', msg); },
  error(msg) { this._write('ERROR', msg); }
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  streamers: [],
  settings: { savePath: path.join(__dirname, 'recordings'), format: 'flv' }
};

const Store = {
  _data: null,

  load() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      this._data = JSON.parse(raw);
    } catch {
      this._data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.save();
    }
    return this._data;
  },

  save() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this._data, null, 2), 'utf-8');
  },

  getAll() { return this._data; },

  getStreamers() { return this._data.streamers; },

  addStreamer(s) {
    this._data.streamers.push(s);
    this.save();
    return s;
  },

  removeStreamer(id) {
    this._data.streamers = this._data.streamers.filter(s => s.id !== id);
    this.save();
  },

  updateStreamer(id, updates) {
    const idx = this._data.streamers.findIndex(s => s.id === id);
    if (idx !== -1) {
      Object.assign(this._data.streamers[idx], updates);
      this.save();
    }
  },

  getSettings() { return this._data.settings; },

  updateSettings(updates) {
    Object.assign(this._data.settings, updates);
    this.save();
  }
};

Store.load();

const BiliAPI = {
  _get(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  },

  async getRoomInfo(roomId) {
    const url = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`;
    const res = await this._get(url);
    if (res.code !== 0) throw new Error(`BiliAPI error: ${res.message}`);
    let name = res.data.title || String(roomId);
    const uid = res.data.uid;
    if (uid) {
      try {
        const userRes = await this._get(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`);
        if (userRes.code === 0 && userRes.data?.info?.uname) {
          name = userRes.data.info.uname;
        }
      } catch {}
    }
    return {
      roomId: String(res.data.room_id),
      name,
      status: res.data.live_status === 1 ? 'live' : 'offline',
      title: res.data.title || ''
    };
  },

  async getStreamUrl(roomId, quality) {
    // Map quality to qn: auto=10000(原画), high=10000, medium=400(蓝光), low=250(超清)
    const qnMap = { auto: 10000, high: 10000, medium: 400, low: 250 };
    const qn = qnMap[quality] || 10000;
    const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0&qn=${qn}&platform=web&ptype=8`;
    const res = await this._get(url);
    if (res.code !== 0) throw new Error(`BiliAPI error: ${res.message}`);
    const streams = res.data?.playurl_info?.playurl?.stream || [];
    // Iterate in reverse — last stream is highest quality
    for (let i = streams.length - 1; i >= 0; i--) {
      for (const format of (streams[i].format || [])) {
        if (format.format_name !== 'flv') continue;
        for (const codec of (format.codec || [])) {
          const baseUrl = codec.base_url || '';
          const host = codec.url_info?.[0]?.host || '';
          const extra = codec.url_info?.[0]?.extra || '';
          if (baseUrl && host) return host + baseUrl + extra;
        }
      }
    }
    throw new Error('No stream URL found');
  }
};

// ─── Recorder ─────────────────────────────────────────────────────────────────

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

let FFMPEG_BIN = findFfmpegPath() || 'ffmpeg';
logger.info(`ffmpeg: ${FFMPEG_BIN}`);

function getFfmpegArgs(streamUrl, filePath, format, quality) {
  const headers = 'Referer: https://live.bilibili.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n';
  const baseArgs = ['-headers', headers, '-i', streamUrl];
  switch (format) {
    case 'mkv':
      return { ext: 'mkv', args: [...baseArgs, '-c', 'copy', '-f', 'matroska', '-y', filePath] };
    case 'ts':
      return { ext: 'ts', args: [...baseArgs, '-c', 'copy', '-f', 'mpegts', '-y', filePath] };
    case 'mp4': {
      // CRF lower = better quality; preset slower = better compression
      const qMap = {
        auto:  { crf: '18', preset: 'medium' },
        high:  { crf: '20', preset: 'fast' },
        medium:{ crf: '23', preset: 'fast' },
        low:   { crf: '28', preset: 'ultrafast' }
      };
      const q = qMap[quality] || qMap.auto;
      return { ext: 'mp4', args: [...baseArgs, '-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf, '-c:a', 'aac', '-f', 'mp4', '-y', filePath] };
    }
    default: // flv
      return { ext: 'flv', args: [...baseArgs, '-c', 'copy', '-f', 'flv', '-y', filePath] };
  }
}

const VIDEO_EXTS = new Set(['.flv', '.mkv', '.ts', '.mp4']);

const Recorder = {
  _processes: {},

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

    // Reuse existing file path if reconnecting, otherwise create new timestamped file
    const safeName = streamerName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 30);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = reusePath || path.join(dir, `${safeName}_${ts}.${ext}`);

    const streamUrl = await BiliAPI.getStreamUrl(roomId, quality);

    const { args } = getFfmpegArgs(streamUrl, filePath, fmt, quality);

    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      // Log stderr to help debug ffmpeg failures
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
        }
        delete this._processes[streamerId];
        if (!settled) {
          settled = true;
          const detail = stderrLog ? ': ' + stderrLog.trim().split('\n').pop() : '';
          reject(new Error(`ffmpeg exited with code ${code} during startup${detail}`));
        }
      });

      // Give ffmpeg 3 seconds to start.
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
        resolve(filePath);
      }, 3000);
    });
  },

  async stop(streamerId) {
    const entry = this._processes[streamerId];
    if (!entry) return null;
    const { process: proc, filePath } = entry;
    delete this._processes[streamerId];
    // Write 'q' to stdin for graceful exit — ffmpeg finalizes MP4 moov atom
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

const DanmakuManager = {
  _engines: {},   // streamerId -> HighlightEngine
  _parsers: {},   // streamerId -> DanmakuParser

  start(streamerId, streamerName, roomId) {
    if (this._parsers[streamerId]) return;
    const engine = createHighlightEngine(streamerId, streamerName, roomId, logger);
    const parser = createDanmakuParser(roomId, logger);
    this._engines[streamerId] = engine;
    this._parsers[streamerId] = parser;
    engine.setRecordingStart(Date.now() / 1000);

    parser.on('danmaku', (d) => engine.feedDanmaku(d.text));
    parser.on('gift', (d) => engine.feedGift(d.rmb));
    parser.on('guard', (d) => engine.feedGuard(d.guardLevel, d.guardName, d.rmb));
    parser.on('close', () => logger.warn(`[danmaku] Parser closed for ${streamerName}`));
    parser.on('error', (d) => logger.warn(`[danmaku] Error for ${streamerName}: ${d.message}`));

    parser.start().catch(e => {
      logger.error(`[danmaku] Failed to start for ${streamerName}: ${e.message}`);
      delete this._parsers[streamerId];
      delete this._engines[streamerId];
    });
    logger.info(`[danmaku] Started for ${streamerName} (room ${roomId})`);
  },

  stop(streamerId) {
    const parser = this._parsers[streamerId];
    if (parser) { parser.stop(); delete this._parsers[streamerId]; }
    if (this._engines[streamerId]) delete this._engines[streamerId];
  },

  getEngine(streamerId) { return this._engines[streamerId] || null; },
  isRunning(streamerId) { return !!this._parsers[streamerId]; }
};

const POLL_INTERVAL = 30_000;  // 30 seconds
const RECONNECT_WINDOW = 2 * 60 * 1000;  // 2 minutes

const Poller = {
  _timer: null,

  start() {
    this._timer = setInterval(() => this.check(), POLL_INTERVAL);
    this.check(); // immediate first check
  },

  async check() {
    const streamers = Store.getStreamers();
    for (const s of streamers) {
      try {
        const info = await BiliAPI.getRoomInfo(s.roomId);
        const prevStatus = s.status;

        // Update name if changed — migrate recordings from old directory
        if (info.name !== s.name) {
          const savePath = Store.getSettings().savePath;
          const oldDir = path.join(savePath, s.name);
          const newDir = path.join(savePath, info.name);
          try {
            if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
              fs.mkdirSync(newDir, { recursive: true });
              const files = fs.readdirSync(oldDir);
              for (const f of files) {
                fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
              }
              fs.rmdirSync(oldDir);
              logger.info(`[poller] Migrated recordings: ${s.name} -> ${info.name} (${files.length} files)`);
            }
          } catch (e) {
            logger.warn(`[poller] Failed to migrate recordings for ${s.name}: ${e.message}`);
          }
          s.name = info.name;
          Store.updateStreamer(s.id, { name: info.name });
        }

        if (info.status === 'live' && prevStatus === 'offline') {
          // Just went live — start recording
          const realRoomId = info.roomId;
          logger.info(`[poller] ${s.name} (room ${s.roomId} real ${realRoomId}) went LIVE`);
          s.status = 'live';
          s.name = info.name;
          Store.updateStreamer(s.id, { status: 'live', name: info.name, lastLiveTime: Date.now(), realRoomId });
          try {
            const filePath = await Recorder.start(s.id, realRoomId, s.name);
            logger.info(`[recorder] Started recording ${s.name} -> ${filePath}`);
            Store.updateStreamer(s.id, { recording: true, lastFilePath: filePath });
            DanmakuManager.start(s.id, s.name, realRoomId);
          } catch (e) {
            logger.error(`[recorder] Failed to start for ${s.name}: ${e.message}`);
          }
        } else if (info.status === 'offline' && prevStatus === 'live') {
          // Just went offline
          logger.info(`[poller] ${s.name} (room ${s.roomId}) went OFFLINE`);
          const wasRecording = Recorder.isRecording(s.id);
          if (wasRecording) {
            const stoppedFile = await Recorder.stop(s.id);
            if (stoppedFile) {
              logger.info(`[recorder] Stopped recording: ${stoppedFile}`);
              const engine = DanmakuManager.getEngine(s.id);
              if (engine) {
                try {
                  const peaks = await analyzeAudio(stoppedFile, logger);
                  if (peaks.length > 0) engine.feedAudioResult(peaks);
                } catch (e) {
                  logger.warn(`[audio] Analysis failed for ${s.name}: ${e.message}`);
                }
              }
            }
          }
          DanmakuManager.stop(s.id);
          Store.updateStreamer(s.id, { status: 'offline', recording: false });
        } else if (info.status === 'live' && prevStatus === 'live') {
          // Still live — check if ffmpeg died (reconnect)
          if (!Recorder.isRecording(s.id)) {
            const lastLive = s.lastLiveTime || 0;
            const gap = Date.now() - lastLive;
            if (gap <= RECONNECT_WINDOW) {
              logger.warn(`[recorder] Reconnecting ${s.name} (gap: ${Math.round(gap/1000)}s, reusing file)`);
              const realRoomId = s.realRoomId || info.roomId;
              try {
                await Recorder.start(s.id, realRoomId, s.name, s.lastFilePath);
                Store.updateStreamer(s.id, { recording: true, lastLiveTime: Date.now() });
              } catch (e) {
                logger.warn(`[recorder] Reconnect failed for ${s.name}: ${e.message}`);
              }
            } else {
              logger.warn(`[recorder] ${s.name} recorder dead >2min, giving up`);
              Store.updateStreamer(s.id, { status: 'offline', recording: false });
            }
          }
        }

      } catch (e) {
        logger.warn(`[poller] Error checking room ${s.roomId}: ${e.message}`);
      }
    }
  },

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
};

// ─── HTTP Server ────────────────────────────────────────────────────────────────

function parseJSON(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Static files
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }

  // API routes
  if (url.pathname === '/api/status' && req.method === 'GET') {
    const streamers = Store.getStreamers();
    const recordings = [];
    const orphaned = [];
    const savePath = Store.getSettings().savePath;
    const streamerNames = new Set(streamers.map(s => s.name));
    for (const s of streamers) {
      const dir = path.join(savePath, s.name);
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) {
            const stat = fs.statSync(path.join(dir, f));
            recordings.push({ filename: s.name + '/' + f, streamerId: s.id, size: stat.size, mtime: stat.mtimeMs, filePath: path.join(dir, f) });
          }
        }
      } catch {}
    }
    // Orphaned: files in directories that don't match any streamer
    try {
      const entries = fs.readdirSync(savePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (streamerNames.has(entry.name)) continue;
        const dir = path.join(savePath, entry.name);
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) {
            const stat = fs.statSync(path.join(dir, f));
            orphaned.push({ filename: entry.name + '/' + f, size: stat.size, mtime: stat.mtimeMs, filePath: path.join(dir, f) });
          }
        }
      }
    } catch {}
    recordings.sort((a, b) => b.mtime - a.mtime);
    orphaned.sort((a, b) => b.mtime - a.mtime);
    sendJSON(res, 200, { streamers, recordings, orphaned });
    return;
  }

  if (url.pathname === '/api/streamer' && req.method === 'POST') {
    const body = await parseJSON(req);
    const input = String(body.roomId || '').trim();
    if (!input) {
      sendJSON(res, 400, { error: 'Invalid input' });
      return;
    }

    let roomId = null;
    // 1. Pure number: direct room ID
    if (/^\d+$/.test(input)) {
      roomId = input;
    }
    // 2. live.bilibili.com/<room_id> URL
    else {
      const urlMatch = input.match(/live\.bilibili\.com\/(\d+)/);
      if (urlMatch) roomId = urlMatch[1];
    }
    // 3. b23.tv short link
    if (!roomId && /b23\.tv/.test(input)) {
      try {
        let shortUrl = input;
        if (!shortUrl.startsWith('http')) shortUrl = 'https://' + shortUrl;
        const redirected = await new Promise((resolve, reject) => {
          https.get(shortUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
            const loc = resp.headers.location || '';
            const match = loc.match(/live\.bilibili\.com\/(\d+)/);
            resolve(match ? match[1] : null);
          }).on('error', reject);
        });
        if (redirected) roomId = redirected;
      } catch {}
    }
    // 4. URL path ending in just the room ID (e.g., https://space.bilibili.com/... but that's UID)
    // For now, skip. Could add UID lookup later via API.

    if (!roomId) {
      sendJSON(res, 400, { error: '无法识别房间号，请输入纯数字房间号、live.bilibili.com 链接或 b23.tv 短链' });
      return;
    }
    if (Store.getStreamers().find(s => s.roomId === roomId)) {
      sendJSON(res, 409, { error: 'Streamer already added' });
      return;
    }
    const defaultFmt = Store.getSettings().format || 'flv';
    const s = { id: Date.now().toString(), roomId, name: roomId, status: 'offline', recording: false, quality: 'auto', format: defaultFmt };
    Store.addStreamer(s);
    // Fetch name immediately
    try {
      const info = await BiliAPI.getRoomInfo(roomId);
      // Merge any recordings left in old directory names
      const savePath = Store.getSettings().savePath;
      for (const oldName of [roomId, '房间' + roomId]) {
        if (oldName === info.name) continue;
        const oldDir = path.join(savePath, oldName);
        const newDir = path.join(savePath, info.name);
        try {
          if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
            fs.mkdirSync(newDir, { recursive: true });
            const files = fs.readdirSync(oldDir);
            for (const f of files) {
              fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
            }
            fs.rmdirSync(oldDir);
            logger.info(`[add] Merged orphaned dir ${oldName} -> ${info.name} (${files.length} files)`);
          }
        } catch {}
      }
      s.name = info.name;
      Store.updateStreamer(s.id, { name: info.name });
    } catch {}
    sendJSON(res, 201, s);
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/start') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    if (Recorder.isRecording(id)) {
      sendJSON(res, 400, { error: 'Already recording' });
      return;
    }
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    const realRoomId = s.realRoomId || s.roomId;
    try {
      await Recorder.start(id, realRoomId, s.name);
      Store.updateStreamer(id, { recording: true, lastLiveTime: Date.now() });
      const s2 = Store.getStreamers().find(s => s.id === id);
      if (s2 && !DanmakuManager.isRunning(id)) {
        DanmakuManager.start(id, s2.name, s2.realRoomId || s2.roomId);
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/stop') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    if (Recorder.isRecording(id)) {
      const stoppedFile = await Recorder.stop(id);
      const engine = DanmakuManager.getEngine(id);
      if (engine && stoppedFile) {
        try {
          const peaks = await analyzeAudio(stoppedFile, logger);
          if (peaks.length > 0) engine.feedAudioResult(peaks);
        } catch (e) {
          logger.warn(`[audio] Analysis failed: ${e.message}`);
        }
      }
      DanmakuManager.stop(id);
      Store.updateStreamer(id, { recording: false });
      sendJSON(res, 200, { ok: true });
    } else {
      sendJSON(res, 400, { error: 'Not recording' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/quality') && req.method === 'PUT') {
    const id = url.pathname.split('/')[3];
    const body = await parseJSON(req);
    const quality = body.quality;
    if (!['auto', 'high', 'medium', 'low'].includes(quality)) {
      sendJSON(res, 400, { error: 'Invalid quality. Use: auto, high, medium, low' });
      return;
    }
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    s.quality = quality;
    Store.updateStreamer(id, { quality });
    sendJSON(res, 200, { ok: true, quality });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/format') && req.method === 'PUT') {
    const id = url.pathname.split('/')[3];
    const body = await parseJSON(req);
    const format = body.format;
    if (!['flv', 'mkv', 'ts', 'mp4'].includes(format)) {
      sendJSON(res, 400, { error: 'Invalid format. Use: flv, mkv, ts, mp4' });
      return;
    }
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    s.format = format;
    Store.updateStreamer(id, { format });
    sendJSON(res, 200, { ok: true, format });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    const deleteFiles = url.searchParams.get('deleteFiles') === 'true';
    const streamer = Store.getStreamers().find(s => s.id === id);
    const streamerName = streamer ? streamer.name : null;
    if (Recorder.isRecording(id)) await Recorder.stop(id);
    DanmakuManager.stop(id);
    Store.removeStreamer(id);
    if (deleteFiles && streamerName) {
      const savePath = Store.getSettings().savePath;
      const dir = path.join(savePath, streamerName);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.info(`[streamer] Deleted recording dir for ${streamerName}: ${dir}`);
      } catch (e) {
        logger.warn(`[streamer] Failed to delete dir for ${streamerName}: ${e.message}`);
      }
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    sendJSON(res, 200, Store.getSettings());
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await parseJSON(req);
    Store.updateSettings(body);
    sendJSON(res, 200, Store.getSettings());
    return;
  }

  if (url.pathname === '/api/check' && req.method === 'POST') {
    Poller.check();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/convert' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath || !fs.existsSync(filePath)) { sendJSON(res, 400, { error: 'File not found' }); return; }
    if (Recorder._processes && Object.values(Recorder._processes).some(e => e.filePath === filePath)) {
      sendJSON(res, 409, { error: '文件正在录制中，请先停止再转换' });
      return;
    }
    const newPath = filePath.replace(/\.flv$/i, '.mkv');
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, ['-i', filePath, '-c', 'copy', '-y', newPath], { stdio: 'ignore' });
        proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
        proc.on('error', reject);
      });
      logger.info(`[convert] ${filePath} -> ${newPath}`);
      sendJSON(res, 200, { ok: true, newPath });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/open-file' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath) { sendJSON(res, 400, { error: 'Missing filePath' }); return; }
    try {
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        const vlcPaths = [
          'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
          'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
        ];
        const fs = require('fs');
        const vlc = vlcPaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
        if (vlc) {
          execFile(vlc, [filePath]);
        } else {
          execFile('cmd', ['/c', 'start', '', filePath]);
        }
      } else if (process.platform === 'darwin') {
        execFile('open', [filePath]);
      } else {
        execFile('xdg-open', [filePath]);
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/recording' && req.method === 'DELETE') {
    const filePath = url.searchParams.get('filePath');
    if (!filePath) { sendJSON(res, 400, { error: 'Missing filePath' }); return; }
    // Check if any active recorder is writing to this file
    for (const [sid, entry] of Object.entries(Recorder._processes)) {
      if (entry.filePath === filePath) {
        sendJSON(res, 409, { error: '文件正在录制中，请先停止录制再删除' });
        return;
      }
    }
    try {
      fs.unlinkSync(filePath);
      logger.info(`[recording] Deleted: ${filePath}`);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    sendJSON(res, 200, { ok: true });
    logger.info('Server shutting down by user request...');
    Poller.stop();
    for (const [sid] of Object.entries(Recorder._processes)) {
      await Recorder.stop(sid);
    }
    for (const [sid] of Object.entries(DanmakuManager._parsers)) {
      DanmakuManager.stop(sid);
    }
    process.exit(0);
    return;
  }

  // ─── Highlight APIs ──────────────────────────────────────────────────────────

  if (url.pathname === '/api/highlights' && req.method === 'GET') {
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!streamerName) { sendJSON(res, 400, { error: 'Missing streamerName' }); return; }
    const data = HighlightStore.getAll(streamerName, date);
    const dates = HighlightStore.listDates(streamerName);
    sendJSON(res, 200, { ...data, availableDates: dates });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date');
    if (!streamerName || !date) { sendJSON(res, 400, { error: 'Missing streamerName or date' }); return; }
    sendJSON(res, HighlightStore.remove(streamerName, date, id) ? 200 : 404, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    const body = await parseJSON(req);
    const { streamerName, date, startOffset, endOffset } = body;
    if (!streamerName || !date) { sendJSON(res, 400, { error: 'Missing streamerName or date' }); return; }
    const updated = HighlightStore.update(streamerName, date, id, { startOffset, endOffset, duration: endOffset - startOffset });
    sendJSON(res, updated ? 200 : 404, updated || { error: 'Not found' });
    return;
  }

  if (url.pathname === '/api/highlights/clip' && req.method === 'POST') {
    const body = await parseJSON(req);
    const { ids, streamerName, date, filePath } = body;
    if (!ids || !ids.length || !streamerName || !date || !filePath) {
      sendJSON(res, 400, { error: 'Missing ids, streamerName, date, or filePath' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      sendJSON(res, 400, { error: 'Source video file not found: ' + filePath });
      return;
    }
    const data = HighlightStore.getAll(streamerName, date);
    const toClip = (data.highlights || []).filter(h => ids.includes(h.id));
    if (toClip.length === 0) {
      sendJSON(res, 400, { error: 'No matching highlights found' });
      return;
    }

    const results = [];
    const clipDir = path.dirname(filePath);

    for (const h of toClip) {
      const srcExt = path.extname(filePath);
      const clipName = path.basename(filePath, srcExt) + '_clip_' + Math.floor(h.startOffset) + 's_' + Math.floor(h.endOffset) + 's' + srcExt;
      const clipPath = path.join(clipDir, clipName);

      try {
        await new Promise((resolve, reject) => {
          const args = [
            '-ss', String(h.startOffset),
            '-to', String(h.endOffset),
            '-i', filePath,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-y', clipPath
          ];
          const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' });
          proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          proc.on('error', reject);
        });

        HighlightStore.update(streamerName, date, h.id, { clipped: true, clipFile: clipPath });
        results.push({ id: h.id, ok: true, clipFile: clipPath });
        logger.info('[clip] ' + clipName + ' (' + Math.floor(h.startOffset) + 's-' + Math.floor(h.endOffset) + 's)');
      } catch (e) {
        results.push({ id: h.id, ok: false, error: e.message });
        logger.error('[clip] Failed: ' + h.id + ' — ' + e.message);
      }
    }

    sendJSON(res, 200, { results });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function migrateOrphanedDirs() {
  const savePath = Store.getSettings().savePath;
  const streamers = Store.getStreamers();
  try {
    const entries = fs.readdirSync(savePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      // Find a streamer whose roomId or old fallback patterns match this directory
      for (const s of streamers) {
        if (dirName === s.name) break; // already correct
        // Check if dirName is the room ID or "房间<roomId>" fallback
        if (dirName === s.roomId || dirName === '房间' + s.roomId) {
          const oldDir = path.join(savePath, dirName);
          const newDir = path.join(savePath, s.name);
          try {
            fs.mkdirSync(newDir, { recursive: true });
            const files = fs.readdirSync(oldDir);
            for (const f of files) {
              fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
            }
            fs.rmdirSync(oldDir);
            logger.info(`[migrate] Merged orphaned dir ${dirName} -> ${s.name} (${files.length} files)`);
          } catch (e) {
            logger.warn(`[migrate] Failed to merge ${dirName}: ${e.message}`);
          }
          break;
        }
      }
    }
  } catch {}
}

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  // Reset stale recording state from previous server run
  for (const s of Store.getStreamers()) {
    if (s.recording || s.status === 'live') {
      Store.updateStreamer(s.id, { status: 'offline', recording: false });
      logger.info(`[init] Reset ${s.name} to offline (server restart)`);
    }
  }
  // Ensure all streamers have format and quality fields
  const defaultFmt = Store.getSettings().format || 'flv';
  for (const s of Store.getStreamers()) {
    const updates = {};
    if (!s.format) updates.format = defaultFmt;
    if (!s.quality) updates.quality = 'auto';
    if (Object.keys(updates).length > 0) Store.updateStreamer(s.id, updates);
  }
  migrateOrphanedDirs();
  logger.info(`Bili Recorder running at http://localhost:${PORT}`);
  Poller.start();
});
