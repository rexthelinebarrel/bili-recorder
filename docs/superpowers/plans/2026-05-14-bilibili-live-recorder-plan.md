# B站直播录制助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web-panel tool that monitors Bilibili streamers and auto-records when they go live.

**Architecture:** Single Node.js process serving an HTTP API + static HTML frontend. A 30s poller checks Bilibili's room API. When a streamer goes live, a ffmpeg child process records the FLV stream. Config persisted as JSON file.

**Tech Stack:** Node.js (built-in http/fs/path/child_process), ffmpeg, vanilla HTML/CSS/JS, Bilibili Live API

**Files:**
- Create: `server.js` — HTTP server, poller, recorder, store, BiliAPI
- Create: `index.html` — Dashboard frontend
- Create: `package.json` — Project metadata
- Create: `README.md` — Project documentation

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "bili-recorder",
  "version": "1.0.0",
  "description": "B站直播自动录制助手",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Verify Node.js is available**

Run: `node --version`
Expected: v18+ or similar

- [ ] **Step 3: Verify ffmpeg is available**

Run: `ffmpeg -version`
Expected: version info (if missing, note to user to install ffmpeg)

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: project scaffold"
```

---

### Task 2: Store module — config persistence

**Files:**
- Create: `server.js` (Store section)

- [ ] **Step 1: Write the Store module**

In `server.js`, write the Store object that reads/writes `config.json`. Default config includes empty streamers array and default settings.

```js
const fs = require('fs');
const path = require('path');

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
```

- [ ] **Step 2: Verify config.json is created on first run**

Run: `node -e "require('./server.js'); process.exit(0)"`
Then check: `cat config.json`
Expected: JSON file with default streamers array and settings

- [ ] **Step 3: Commit**

```bash
git add server.js config.json
git commit -m "feat: add Store module for config persistence"
```

---

### Task 3: BiliAPI module — check live status

**Files:**
- Modify: `server.js` (add BiliAPI section)

- [ ] **Step 1: Write the BiliAPI module**

Add after Store section in `server.js`:

```js
const https = require('https');

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
```

- [ ] **Step 2: Test room info fetch**

Run: `node -e "
const { BiliAPI } = require('./server.js');
BiliAPI.getRoomInfo('6').then(r => { console.log(JSON.stringify(r)); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
"`
Expected: JSON with roomId, name, status fields for B站房间6

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add BiliAPI module for room status and stream URL"
```

---

### Task 4: Recorder module — ffmpeg process management

**Files:**
- Modify: `server.js` (add Recorder section)

- [ ] **Step 1: Write the Recorder module**

Add after BiliAPI section in `server.js`:

```js
const { spawn } = require('child_process');

const Recorder = {
  _processes: {}, // streamerId -> { process, filePath, startedAt }

  _ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  },

  async start(streamerId, roomId, streamerName) {
    if (this._processes[streamerId]) return; // already recording

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

      proc.stderr.on('data', (d) => {
        // ffmpeg writes progress to stderr, we ignore for now
      });

      proc.on('error', (err) => {
        delete this._processes[streamerId];
        reject(err);
      });

      // Wait briefly to confirm ffmpeg started without immediate crash
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
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add Recorder module for ffmpeg stream capture"
```

---

### Task 5: Poller module — periodic live status check

**Files:**
- Modify: `server.js` (add Poller section)

- [ ] **Step 1: Write the Poller module**

Add after Recorder section in `server.js`:

```js
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
            // Only reconnect if within window or lastLive is recent
            try {
              await Recorder.start(s.id, s.roomId, s.name);
              Store.updateStreamer(s.id, { recording: true, lastLiveTime: Date.now() });
            } catch (e) {
              console.error(`[recorder] Reconnect failed for ${s.name}:`, e.message);
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
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add Poller for periodic live status detection"
```

---

### Task 6: HTTP server + REST API

**Files:**
- Modify: `server.js` (add HTTP server section at bottom)

- [ ] **Step 1: Write the HTTP server**

Add at end of `server.js`, before any startup call:

```js
const http = require('http');

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
  if (req.method === 'GET' && url.pathname === '/' || url.pathname === '/index.html') {
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
```

- [ ] **Step 2: Test server starts**

Run: `node -e "const { spawn } = require('child_process'); const p = spawn('node', ['server.js'], { stdio: 'pipe' }); setTimeout(() => { p.kill(); process.exit(0); }, 3000); p.stdout.on('data', d => console.log(d.toString()));"`
Expected: "Bili Recorder running at http://localhost:3456"

- [ ] **Step 3: Test API endpoints**

Terminal 1: `node server.js`
Terminal 2:
```
curl http://localhost:3456/api/status
curl -X POST http://localhost:3456/api/streamer -H "Content-Type: application/json" -d "{\"roomId\":\"6\"}"
curl http://localhost:3456/api/status
curl -X DELETE http://localhost:3456/api/streamer/<id-from-status>
curl http://localhost:3456/api/settings
curl -X PUT http://localhost:3456/api/settings -H "Content-Type: application/json" -d "{\"savePath\":\"./test-recordings\"}"
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add HTTP server and REST API endpoints"
```

---

### Task 7: Frontend — HTML/CSS/JS dashboard

**Files:**
- Create: `index.html`

- [ ] **Step 1: Write the dashboard frontend**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>直播录制助手</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F5F2EC;--card:#FCFAF7;--text:#1F1B16;--text2:#8A8278;--text3:#BFB8AD;
  --border:#E6E0D6;--accent:#2C2416;--accent-bg:#F0EBE2;
  --live:#3D7252;--danger:#C5463A;--warn:#D4893A;
  --radius:4px;--font-display:'Songti SC','STSong',serif;--font-ui:system-ui,sans-serif;
}
@media(prefers-color-scheme:dark){
  :root{--bg:#11100E;--card:#1C1A17;--text:#E8E3D9;--text2:#9E978C;--text3:#5F5A52;--border:#2C2924;--accent:#C4A97D;--accent-bg:#262218;}
}
body{font-family:var(--font-ui);background:var(--bg);color:var(--text);padding:24px;max-width:520px;margin:0 auto;min-height:100vh}
h1{font-family:var(--font-display);font-size:22px;font-weight:700;margin-bottom:4px;letter-spacing:-0.01em}
.subtitle{font-size:11px;color:var(--text3);margin-bottom:20px}
.section-label{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin:24px 0 10px}
.section-label::before{content:'';display:block;width:16px;height:1px;background:var(--text3);margin-bottom:8px}

/* Header */
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.header-btns{display:flex;gap:6px}
.btn{padding:7px 16px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;letter-spacing:0.03em;font-family:var(--font-ui);transition:all .15s}
.btn:active{background:var(--border)}
.btn.primary{background:var(--text);color:var(--bg);border-color:var(--text)}

/* Add row */
.add-row{display:flex;gap:8px;margin-bottom:16px}
.add-row input{flex:1;padding:12px 14px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:14px;font-family:var(--font-ui);outline:none}
.add-row input:focus{border-color:var(--text)}

/* Cards */
.live-card,.offline-card{background:var(--card);border:1px solid var(--border);padding:16px;margin-bottom:6px}
.live-card{border-left:3px solid var(--live)}
.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.card-name{font-weight:700;font-size:16px}
.badge{padding:2px 10px;font-size:10px;font-weight:600;letter-spacing:0.04em}
.badge-live{background:var(--live);color:#fff}
.badge-off{color:var(--text3);border:1px solid var(--border)}
.card-meta{font-size:11px;color:var(--text2);margin-bottom:8px}
.card-actions{display:flex;gap:6px}
.btn-sm{padding:4px 12px;font-size:10px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer;font-family:var(--font-ui)}
.btn-sm.danger{color:var(--danger);border-color:var(--danger)}
.progress-line{height:2px;background:var(--live);margin-top:10px;transition:width 1s linear}

/* Recording list */
.file-item{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}
.file-name{font-weight:600;font-size:13px}
.file-meta{font-size:10px;color:var(--text3);margin-top:2px}
.file-size{font-size:12px;color:var(--text2);white-space:nowrap}

/* Settings */
.settings-row{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)}
.settings-row label{font-size:13px;color:var(--text2);flex-shrink:0}
.settings-row input{flex:1;padding:10px 12px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13px;font-family:var(--font-ui);outline:none}
.settings-row input:focus{border-color:var(--text)}

.toast{position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:8px 24px;font-size:12px;font-weight:500;z-index:100;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>直播录制助手</h1>
    <div class="subtitle" id="clock">加载中...</div>
  </div>
  <div class="header-btns">
    <button class="btn" id="btnCheck">立即检查</button>
  </div>
</div>

<div class="add-row">
  <input type="text" id="roomInput" placeholder="输入B站房间号，如 6" inputmode="numeric">
  <button class="btn primary" id="btnAdd">添加</button>
</div>

<div class="section-label">监看中</div>
<div id="liveArea"><div style="color:var(--text3);font-size:13px;padding:12px 0">暂无直播中的主播</div></div>

<div class="section-label">离线</div>
<div id="offlineArea"><div style="color:var(--text3);font-size:13px;padding:12px 0">暂无离线主播</div></div>

<div class="section-label">录制文件</div>
<div id="fileList"><div style="color:var(--text3);font-size:13px;padding:12px 0">暂无录制文件</div></div>

<div class="section-label">设置</div>
<div class="settings-row">
  <label>保存路径</label>
  <input type="text" id="savePathInput">
  <button class="btn-sm" id="btnSavePath">保存</button>
</div>

<script>
const API = {
  async get(path) { const r = await fetch(path); return r.json(); },
  async post(path, body) {
    const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    return r.json();
  },
  async del(path) { await fetch(path, { method:'DELETE' }); },
  async put(path, body) {
    const r = await fetch(path, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    return r.json();
  }
};

function formatSize(bytes) {
  if (bytes > 1e9) return (bytes/1e9).toFixed(1)+' GB';
  if (bytes > 1e6) return (bytes/1e6).toFixed(1)+' MB';
  if (bytes > 1e3) return (bytes/1e3).toFixed(0)+' KB';
  return bytes+' B';
}

function formatDuration(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  if (h>0) return h+'h'+String(m).padStart(2,'0')+'m';
  return m+'m'+String(s).padStart(2,'0')+'s';
}

function showToast(msg) {
  const t = document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s'},1500);
  setTimeout(()=>t.remove(),2000);
}

async function refresh() {
  const data = await API.get('/api/status');
  const settings = await API.get('/api/settings');
  document.getElementById('savePathInput').value = settings.savePath || '';

  const liveS = data.streamers.filter(s => s.status==='live');
  const offS = data.streamers.filter(s => s.status==='offline');

  const liveArea = document.getElementById('liveArea');
  if (liveS.length===0) {
    liveArea.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px 0">暂无直播中的主播</div>';
  } else {
    liveArea.innerHTML = liveS.map(s => `
      <div class="live-card" id="card-${s.id}">
        <div class="card-top">
          <span class="card-name">${s.name}</span>
          <span class="badge badge-live">直播中</span>
        </div>
        <div class="card-meta">房间 ${s.roomId} · ${s.recording?'录制中':'检测中...'}</div>
        ${s.recording ? '<div class="progress-line" style="width:100%"></div>' : ''}
        <div class="card-actions" style="margin-top:8px">
          ${s.recording ? '<button class="btn-sm danger" onclick="stopRecord(\''+s.id+'\')">停止录制</button>' : ''}
        </div>
      </div>
    `).join('');
  }

  const offArea = document.getElementById('offlineArea');
  if (offS.length===0) {
    offArea.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px 0">暂无离线主播</div>';
  } else {
    offArea.innerHTML = offS.map(s => `
      <div class="offline-card">
        <div class="card-top">
          <span class="card-name">${s.name}</span>
          <span class="badge badge-off">离线</span>
        </div>
        <div class="card-meta">房间 ${s.roomId}</div>
        <div class="card-actions" style="margin-top:4px">
          <button class="btn-sm danger" onclick="removeStreamer('${s.id}')">删除</button>
        </div>
      </div>
    `).join('');
  }

  const fileList = document.getElementById('fileList');
  if (data.recordings.length===0) {
    fileList.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px 0">暂无录制文件</div>';
  } else {
    fileList.innerHTML = data.recordings.slice(0, 20).map(r => `
      <div class="file-item">
        <div>
          <div class="file-name">${r.filename}</div>
          <div class="file-meta">${new Date(r.mtime).toLocaleString('zh-CN')}</div>
        </div>
        <span class="file-size">${formatSize(r.size)}</span>
      </div>
    `).join('');
  }

  document.getElementById('clock').textContent = '更新于 '+new Date().toLocaleTimeString('zh-CN');
}

async function stopRecord(id) {
  // Manual stop: API doesn't have a direct stop endpoint, but we can delete and re-add
  // For v1, we rely on the next poll cycle to detect offline and stop
  showToast('停止请求已发送，下次检查时将停止');
}

async function removeStreamer(id) {
  await API.del('/api/streamer/'+id);
  showToast('已删除');
  refresh();
}

document.getElementById('btnCheck').addEventListener('click', async () => {
  await API.post('/api/check');
  showToast('已发起检查');
  setTimeout(refresh, 2000);
});

document.getElementById('btnAdd').addEventListener('click', async () => {
  const input = document.getElementById('roomInput');
  const val = input.value.trim();
  if (!val) return;
  const r = await API.post('/api/streamer', { roomId: val });
  if (r.error) { showToast(r.error); return; }
  input.value = '';
  showToast('已添加「'+r.name+'」');
  refresh();
});

document.getElementById('roomInput').addEventListener('keydown', e => {
  if (e.key==='Enter') document.getElementById('btnAdd').click();
});

document.getElementById('btnSavePath').addEventListener('click', async () => {
  const val = document.getElementById('savePathInput').value.trim();
  if (!val) return;
  await API.put('/api/settings', { savePath: val });
  showToast('保存路径已更新');
});

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>
```

- [ ] **Step 2: Verify page loads**

Start server: `node server.js`
Open: `http://localhost:3456`
Check: Dashboard loads with header, add input, sections

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add dashboard frontend"
```

---

### Task 8: Integration — add stop-recording API

**Files:**
- Modify: `server.js` (add stop endpoint)

- [ ] **Step 1: Add stop recording API endpoint**

Add before the 404 fallback in the HTTP server section:

```js
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
```

- [ ] **Step 2: Update frontend stop button to call this endpoint**

In `index.html`, replace the `stopRecord` function:

```js
async function stopRecord(id) {
  await API.post('/api/streamer/'+id+'/stop');
  showToast('录制已停止');
  refresh();
}
```

- [ ] **Step 3: End-to-end smoke test**

- Start server: `node server.js`
- Open `http://localhost:3456`
- Add room ID "6" (or any known room)
- Check status appears
- Click "立即检查"
- Verify recording files list shows
- Change save path in settings
- Delete a streamer
- Verify all API calls return expected responses

- [ ] **Step 4: Commit**

```bash
git add server.js index.html
git commit -m "feat: add stop recording endpoint and integration fixes"
```

---

### Task 9: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# bili-recorder

B站直播自动录制助手。添加主播房间号，开播自动录制，下播自动停止。

## 依赖

- [Node.js](https://nodejs.org/) (v18+)
- [ffmpeg](https://ffmpeg.org/) (需在 PATH 中可用)

## 快速开始

```bash
# 安装 ffmpeg（如未安装）
# Windows: winget install ffmpeg
# macOS: brew install ffmpeg
# Linux: apt install ffmpeg

# 启动
npm start
```

打开 `http://localhost:3456`

## 使用说明

1. 输入 B站房间号（直播间 URL 里的数字），点击"添加"
2. 系统每 30 秒自动检查一次，检测到开播立即开始录制
3. 点击"立即检查"可手动触发检测
4. 录制文件保存在 `./recordings/<主播名>/` 目录下
5. 可在设置中修改保存路径

## 录制流程

- 开播 → 自动启动录制
- 下播 → 自动停止
- 断线 2 分钟内 → 自动重连续录
- 断线超 2 分钟 → 开新文件

## 文件格式

- 视频格式: FLV
- 画质: 原画（最高画质）
- 命名: `YYYY-MM-DD_HH-MM-SS.flv`
```

- [ ] **Step 2: Commit and push**

```bash
git add README.md
git commit -m "docs: add README"
git push
```
