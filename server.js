const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

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
