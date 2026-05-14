const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  streamers: [],
  settings: { savePath: path.join(__dirname, 'recordings') }
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
    const url = `https://api.live.bilibili.com/room/v1/Room/playUrl?room_id=${roomId}&platform=web&qn=10000`;
    const res = await this._get(url);
    if (res.code !== 0) throw new Error(`BiliAPI error: ${res.message}`);
    const streams = res.data?.playurl_info?.playurl?.stream || [];
    // Prefer the first available stream URL
    for (const stream of streams) {
      for (const format of (stream.format || [])) {
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

const Recorder = {
  _processes: {},

  _ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  },

  async start(streamerId, roomId, streamerName) {
    if (this._processes[streamerId]) return;

    const savePath = Store.getSettings().savePath;
    const dir = path.join(savePath, streamerName);
    this._ensureDir(dir);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(dir, `${ts}.flv`);

    const streamUrl = await BiliAPI.getStreamUrl(roomId);

    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', streamUrl,
        '-c', 'copy',
        '-f', 'flv',
        '-y',
        filePath
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.stderr.on('data', (d) => {});

      proc.on('error', (err) => {
        delete this._processes[streamerId];
        reject(err);
      });

      setTimeout(() => {
        if (proc.exitCode !== null && proc.exitCode !== 0) {
          delete this._processes[streamerId];
          reject(new Error('ffmpeg exited immediately'));
          return;
        }
        this._processes[streamerId] = {
          process: proc,
          filePath,
          startedAt: Date.now()
        };
        proc.on('exit', () => { delete this._processes[streamerId]; });
        resolve(filePath);
      }, 2000);
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
          s.status = 'live';
          s.name = info.name;
          Store.updateStreamer(s.id, { status: 'live', name: info.name, lastLiveTime: Date.now() });
          try {
            await Recorder.start(s.id, s.roomId, s.name);
            Store.updateStreamer(s.id, { recording: true });
          } catch (e) {
            console.error(`[recorder] Failed to start for ${s.name}:`, e.message);
          }
        } else if (info.status === 'offline' && prevStatus === 'live') {
          // Just went offline
          const wasRecording = Recorder.isRecording(s.id);
          if (wasRecording) {
            Recorder.stop(s.id);
          }
          Store.updateStreamer(s.id, { status: 'offline', recording: false });
        } else if (info.status === 'live' && prevStatus === 'live') {
          // Still live — check if ffmpeg died (reconnect)
          if (!Recorder.isRecording(s.id)) {
            const lastLive = s.lastLiveTime || 0;
            const gap = Date.now() - lastLive;
            if (gap <= RECONNECT_WINDOW) {
              try {
                await Recorder.start(s.id, s.roomId, s.name);
                Store.updateStreamer(s.id, { recording: true, lastLiveTime: Date.now() });
              } catch (e) {
                console.error(`[recorder] Reconnect failed for ${s.name}:`, e.message);
              }
            }
          }
        }

      } catch (e) {
        console.error(`[poller] Error checking room ${s.roomId}:`, e.message);
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
          if (f.endsWith('.flv')) {
            const stat = fs.statSync(path.join(dir, f));
            recordings.push({ filename: s.name + '/' + f, streamerId: s.id, size: stat.size, mtime: stat.mtimeMs });
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
    const roomId = String(body.roomId || '').trim();
    if (!roomId || !/^\d+$/.test(roomId)) {
      sendJSON(res, 400, { error: 'Invalid room ID' });
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

  res.writeHead(404);
  res.end('Not Found');
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`Bili Recorder running at http://localhost:${PORT}`);
  Poller.start();
});
