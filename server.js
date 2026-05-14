const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');

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
    return {
      roomId: String(res.data.room_id),
      name: res.data.anchor_info?.base_info?.uname || `房间${roomId}`,
      status: res.data.live_status === 1 ? 'live' : 'offline',
      title: res.data.title || ''
    };
  },

  async getStreamUrl(roomId) {
    const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=web&ptype=8`;
    const res = await this._get(url);
    if (res.code !== 0) throw new Error(`BiliAPI error: ${res.message}`);
    const streams = res.data?.playurl_info?.playurl?.stream || [];
    // Prefer FLV (format_name=flv) with AVC codec for ffmpeg compatibility
    for (const stream of streams) {
      for (const format of (stream.format || [])) {
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

function getFfmpegArgs(streamUrl, filePath, format) {
  const baseArgs = ['-i', streamUrl];
  switch (format) {
    case 'mkv':
      return { ext: 'mkv', args: [...baseArgs, '-c', 'copy', '-f', 'matroska', '-y', filePath] };
    case 'ts':
      return { ext: 'ts', args: [...baseArgs, '-c', 'copy', '-f', 'mpegts', '-y', filePath] };
    case 'mp4':
      return { ext: 'mp4', args: [...baseArgs, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mp4', '-y', filePath] };
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

    const fmt = Store.getSettings().format || 'flv';
    const { ext } = getFfmpegArgs('', '', fmt);

    const savePath = Store.getSettings().savePath;
    const dir = path.join(savePath, streamerName);
    this._ensureDir(dir);

    // Reuse existing file path if reconnecting, otherwise create new timestamped file
    const filePath = reusePath || path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`);

    const streamUrl = await BiliAPI.getStreamUrl(roomId);

    const { args } = getFfmpegArgs(streamUrl, filePath, fmt);

    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
          reject(new Error(`ffmpeg exited with code ${code} during startup`));
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

  stop(streamerId) {
    const entry = this._processes[streamerId];
    if (!entry) return null;
    entry.process.kill('SIGTERM');
    const filePath = entry.filePath;
    delete this._processes[streamerId];
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
          } catch (e) {
            logger.error(`[recorder] Failed to start for ${s.name}: ${e.message}`);
          }
        } else if (info.status === 'offline' && prevStatus === 'live') {
          // Just went offline
          logger.info(`[poller] ${s.name} (room ${s.roomId}) went OFFLINE`);
          const wasRecording = Recorder.isRecording(s.id);
          if (wasRecording) {
            const stoppedFile = Recorder.stop(s.id);
            if (stoppedFile) logger.info(`[recorder] Stopped recording: ${stoppedFile}`);
          }
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
    const savePath = Store.getSettings().savePath;
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
    recordings.sort((a, b) => b.mtime - a.mtime);
    sendJSON(res, 200, { streamers, recordings });
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
    const s = { id: Date.now().toString(), roomId, name: roomId, status: 'offline', recording: false };
    Store.addStreamer(s);
    // Fetch name immediately
    try {
      const info = await BiliAPI.getRoomInfo(roomId);
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
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/stop') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    if (Recorder.isRecording(id)) {
      Recorder.stop(id);
      Store.updateStreamer(id, { recording: false });
      sendJSON(res, 200, { ok: true });
    } else {
      sendJSON(res, 400, { error: 'Not recording' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    if (Recorder.isRecording(id)) Recorder.stop(id);
    Store.removeStreamer(id);
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

  if (url.pathname === '/api/open-file' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath) { sendJSON(res, 400, { error: 'Missing filePath' }); return; }
    try {
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        execFile('cmd', ['/c', 'start', '', filePath]);
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

  res.writeHead(404);
  res.end('Not Found');
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  // Reset stale recording state from previous server run
  for (const s of Store.getStreamers()) {
    if (s.recording || s.status === 'live') {
      Store.updateStreamer(s.id, { status: 'offline', recording: false });
      logger.info(`[init] Reset ${s.name} to offline (server restart)`);
    }
  }
  logger.info(`Bili Recorder running at http://localhost:${PORT}`);
  Poller.start();
});
