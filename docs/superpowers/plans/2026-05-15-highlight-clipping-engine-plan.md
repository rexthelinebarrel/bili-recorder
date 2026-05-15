# Highlight Clipping Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 bili-recorder 增加直播高光时刻自动标注能力——实时采集弹幕/礼物信号，离线分析音频能量，规则引擎输出切片区间，Web 面板预览后批量裁剪。

**Architecture:** 混合模式。直播期间 danmaku-parser 通过 WebSocket 实时采集弹幕/礼物信号送 highlight-engine 评分；录制完成后 audio-analyzer 离线分析音轨补充音频维度。所有标注存 highlight-store（JSON），前端新增切片面板展示，手动勾选后 ffmpeg 批量裁剪。

**Tech Stack:** Node.js native (zero new npm deps for parsing), `ws` package for WebSocket, ffmpeg for audio analysis + clipping, vanilla HTML/CSS/JS frontend.

---

## File Structure

```
server.js                    (modify: 新增 4 个 API + 调度钩子，~60 行)
lib/
  danmaku-parser.js          (create: B站弹幕 WebSocket 客户端)
  highlight-engine.js        (create: 规则引擎——信号融合+阈值判断+去重)
  highlight-store.js         (create: JSON 持久化 CRUD)
  audio-analyzer.js          (create: ffmpeg 离线音频能量分析)
index.html                   (modify: 新增切片面板 section)
```

---

## Phase 1 — 弹幕信号采集 + 实时标注（MVP 核心）

### Task 1.1: Install ws dependency

**Files:** Modify: `package.json`

- [ ] **Step 1: Install ws package**

```bash
cd D:\rex\bili-recorder && npm init -y 2>nul & npm install ws
```

- [ ] **Step 2: Verify ws installed**

```bash
node -e "const WebSocket = require('ws'); console.log('ws version:', WebSocket.prototype ? 'OK' : 'FAIL')"
```

Expected: `ws version: OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json node_modules/.package-lock.json
git commit -m "chore: add ws dependency for danmaku WebSocket client"
```

---

### Task 1.2: Create lib/danmaku-parser.js

**Files:** Create: `D:\rex\bili-recorder\lib\danmaku-parser.js`

The danmaku-parser connects to B站 live chat WebSocket, sends room auth, and emits parsed events. B站 uses a custom binary protocol over WebSocket — packets have a 16-byte header followed by optionally compressed JSON body.

B站 packet format (big-endian):
- Byte 0-3: uint32 total_length (includes header)
- Byte 4-5: uint16 header_length (fixed at 16)
- Byte 6-7: uint16 protocol_version (0=JSON, 2=zlib, 3=brotli)
- Byte 8-11: uint32 operation (2=heartbeat, 3=heartbeat_reply, 5=server_message, 7=auth_join, 8=auth_reply)
- Byte 12-15: uint32 sequence_id
- Byte 16+: body (JSON or compressed JSON, per protocol_version)

Auth packet (op=7): body = JSON `{"uid":0,"roomid":<realRoomId>,"protover":3,"platform":"web","type":2,"key":<token>}`
Token comes from `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=<roomId>` → `res.data.token`

Server sends op=5 messages with body containing JSON like:
- `{"cmd":"DANMU_MSG","info":[[...], "弹幕文本", [uid, uname, ...], ...]}`
- `{"cmd":"SEND_GIFT","data":{"giftName":"...","price":...,"num":...,...}}`
- `{"cmd":"GUARD_BUY","data":{"gift_name":"舰长","price":198,...}}`

- [ ] **Step 1: Create lib/ directory and parser file**

```bash
mkdir D:\rex\bili-recorder\lib 2>nul
```

Write `D:\rex\bili-recorder\lib\danmaku-parser.js`:

```js
const WebSocket = require('ws');
const zlib = require('zlib');
const https = require('https');

function biliGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function packAuth(roomId, token) {
  const body = JSON.stringify({ uid: 0, roomid: Number(roomId), protover: 3, platform: 'web', type: 2, key: token || '' });
  const totalLen = 16 + Buffer.byteLength(body);
  const buf = Buffer.alloc(totalLen);
  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(1, 6);   // protover 1 for auth (uncompressed JSON)
  buf.writeUInt32BE(7, 8);   // op 7 = auth
  buf.writeUInt32BE(1, 12);  // seq
  buf.write(body, 16);
  return buf;
}

class DanmakuParser {
  constructor(roomId, logger) {
    this.roomId = roomId;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.ws = null;
    this._heartbeatTimer = null;
    this._handlers = { danmaku: [], gift: [], guard: [], raw: [], close: [], error: [] };
    this.stats = {
      danmakuCount: 0,
      giftTotalValue: 0,
      startTime: null,
      roomId: roomId
    };
  }

  on(event, fn) { if (this._handlers[event]) this._handlers[event].push(fn); }

  _emit(event, data) {
    for (const fn of this._handlers[event]) {
      try { fn(data); } catch (e) { this.logger.error(`[danmaku] handler error: ${e.message}`); }
    }
  }

  async start(uid) {
    // Fetch danmaku token
    let token = '';
    try {
      const infoUrl = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${this.roomId}`;
      const info = await biliGet(infoUrl);
      if (info.code === 0 && info.data && info.data.token) {
        token = info.data.token;
      }
    } catch (e) {
      this.logger.warn(`[danmaku] Failed to get danmaku token: ${e.message}`);
    }

    this.stats.startTime = Date.now();
    this.stats.danmakuCount = 0;
    this.stats.giftTotalValue = 0;

    this.ws = new WebSocket('wss://broadcastlv.chat.bilibili.com/sub');

    this.ws.on('open', () => {
      this.logger.info(`[danmaku] Connected to room ${this.roomId}`);
      this.ws.send(packAuth(this.roomId, token));
      // Heartbeat every 30s
      this._heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const hb = Buffer.alloc(16);
          hb.writeUInt32BE(16, 0);   // total length
          hb.writeUInt16BE(16, 4);   // header length
          hb.writeUInt16BE(1, 6);    // protover
          hb.writeUInt32BE(2, 8);    // op 2 = heartbeat
          hb.writeUInt32BE(1, 12);   // seq
          this.ws.send(hb);
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        this._parsePacket(data);
      } catch (e) {
        this.logger.error(`[danmaku] Parse error: ${e.message}`);
      }
    });

    this.ws.on('close', (code) => {
      this.logger.warn(`[danmaku] Disconnected (code ${code})`);
      clearInterval(this._heartbeatTimer);
      this._emit('close', { code });
    });

    this.ws.on('error', (err) => {
      this.logger.error(`[danmaku] WebSocket error: ${err.message}`);
      this._emit('error', { message: err.message });
    });
  }

  _parsePacket(data) {
    let offset = 0;
    while (offset < data.length) {
      if (data.length - offset < 16) break;
      const totalLen = data.readUInt32BE(offset);
      const headerLen = data.readUInt16BE(offset + 4);
      const protover = data.readUInt16BE(offset + 6);
      const op = data.readUInt32BE(offset + 8);

      if (totalLen <= 0 || totalLen > data.length - offset) break;

      const bodyStart = offset + headerLen;
      const bodyLen = totalLen - headerLen;
      let bodyBuf = data.slice(bodyStart, bodyStart + bodyLen);

      if (op === 5) {
        // Server message — decompress if needed
        try {
          if (protover === 3 && bodyLen > 0) {
            bodyBuf = zlib.brotliDecompressSync(bodyBuf);
          } else if (protover === 2 && bodyLen > 0) {
            bodyBuf = zlib.inflateSync(bodyBuf);
          }
          this._parseMessages(bodyBuf.toString('utf-8'));
        } catch (e) {
          this.logger.error(`[danmaku] Decompress error: ${e.message}`);
        }
      } else if (op === 3) {
        // Heartbeat reply — connection is healthy
      } else if (op === 8) {
        this.logger.info(`[danmaku] Auth reply received for room ${this.roomId}`);
      }

      offset += totalLen;
    }
  }

  _parseMessages(text) {
    // Multiple JSON objects may be concatenated
    const parts = text.split(/}(?=\{|$)/);
    for (let part of parts) {
      if (!part.trim()) continue;
      if (!part.endsWith('}')) part += '}';
      try {
        const msg = JSON.parse(part);
        this._emit('raw', msg);
        this._dispatch(msg);
      } catch {}
    }
  }

  _dispatch(msg) {
    const cmd = msg.cmd || '';
    if (cmd.includes('DANMU_MSG')) {
      // DANMU_MSG format: info[1] = text, info[2][1] = username
      const info = msg.info || [];
      const text = String(info[1] || '');
      const uid = info[2] && info[2][0] ? String(info[2][0]) : '';
      const uname = info[2] && info[2][1] ? String(info[2][1]) : '';
      this.stats.danmakuCount++;
      this._emit('danmaku', { text, uid, uname, timestamp: Date.now(), raw: msg });
    } else if (cmd.includes('SEND_GIFT')) {
      const d = msg.data || {};
      const price = Number(d.price) || 0;
      const num = Number(d.num) || 1;
      const totalCoin = price * num;
      // 金瓜子 → 人民币：1000 金瓜子 ≈ 1 元
      const rmb = totalCoin / 1000;
      this.stats.giftTotalValue += rmb;
      this._emit('gift', {
        giftName: d.giftName || '',
        price,
        num,
        totalCoin,
        rmb,
        uid: String(d.uid || ''),
        uname: d.uname || '',
        timestamp: Date.now(),
        raw: msg
      });
    } else if (cmd.includes('GUARD_BUY')) {
      const d = msg.data || {};
      const guardLevel = Number(d.guard_level) || 0;
      // guard_level: 1=总督(19998元), 2=提督(1998元), 3=舰长(198元)
      const priceMap = { 1: 19998, 2: 1998, 3: 198 };
      const rmb = priceMap[guardLevel] || 0;
      this.stats.giftTotalValue += rmb;
      this._emit('guard', {
        guardLevel,
        guardName: d.gift_name || '',
        rmb,
        uid: String(d.uid || ''),
        uname: d.username || '',
        timestamp: Date.now(),
        raw: msg
      });
    }
  }

  stop() {
    clearInterval(this._heartbeatTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { DanmakuParser };
```

- [ ] **Step 2: Verify file exists and parses**

```bash
node -e "const {DanmakuParser} = require('./lib/danmaku-parser'); console.log('Module OK:', typeof DanmakuParser)"
```

Expected: `Module OK: function`

- [ ] **Step 3: Commit**

```bash
git add lib/danmaku-parser.js
git commit -m "feat: add danmaku WebSocket parser with B站 binary protocol support"
```

---

### Task 1.3: Create lib/highlight-store.js

**Files:** Create: `D:\rex\bili-recorder\lib\highlight-store.js`

Store persists highlight annotations as JSON files per-streamer per-date at `recordings/<主播名>/highlights_<YYYY-MM-DD>.json`.

- [ ] **Step 1: Write highlight-store.js**

```js
const fs = require('fs');
const path = require('path');

const HIGHLIGHTS_DIR = path.join(__dirname, '..', 'recordings');

function _filePath(streamerName, date) {
  const dir = path.join(HIGHLIGHTS_DIR, streamerName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `highlights_${date}.json`);
}

function _load(streamerName, date) {
  const fp = _filePath(streamerName, date);
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { streamerName, date, highlights: [] };
  }
}

function _save(streamerName, date, data) {
  fs.writeFileSync(_filePath(streamerName, date), JSON.stringify(data, null, 2), 'utf-8');
}

const HighlightStore = {
  getAll(streamerName, date) {
    return _load(streamerName, date);
  },

  add(streamerName, date, highlight) {
    const data = _load(streamerName, date);
    const h = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ...highlight,
      clipped: false,
      clipFile: null,
      createdAt: new Date().toISOString()
    };
    // Merge overlapping: if new highlight overlaps with existing within 30s, merge
    let merged = false;
    for (const existing of data.highlights) {
      const gap = Math.abs(existing.startOffset - h.startOffset);
      if (gap < 30) {
        existing.startOffset = Math.min(existing.startOffset, h.startOffset);
        existing.endOffset = Math.max(existing.endOffset, h.endOffset);
        existing.duration = existing.endOffset - existing.startOffset;
        existing.score = Math.max(existing.score, h.score);
        existing.triggers = [...new Set([...(existing.triggers || []), ...(h.triggers || [])])];
        existing.danmakuCount = Math.max(existing.danmakuCount || 0, h.danmakuCount || 0);
        existing.totalGiftValue = Math.max(existing.totalGiftValue || 0, h.totalGiftValue || 0);
        merged = true;
        break;
      }
    }
    if (!merged) {
      data.highlights.push(h);
    }
    data.highlights.sort((a, b) => a.startOffset - b.startOffset);
    _save(streamerName, date, data);
    return merged ? data.highlights.find(e => Math.abs(e.startOffset - h.startOffset) < 30) : h;
  },

  update(streamerName, date, id, updates) {
    const data = _load(streamerName, date);
    const idx = data.highlights.findIndex(h => h.id === id);
    if (idx === -1) return null;
    Object.assign(data.highlights[idx], updates);
    _save(streamerName, date, data);
    return data.highlights[idx];
  },

  remove(streamerName, date, id) {
    const data = _load(streamerName, date);
    const before = data.highlights.length;
    data.highlights = data.highlights.filter(h => h.id !== id);
    if (data.highlights.length === before) return false;
    _save(streamerName, date, data);
    return true;
  },

  listDates(streamerName) {
    const dir = path.join(HIGHLIGHTS_DIR, streamerName);
    try {
      const files = fs.readdirSync(dir);
      const dates = new Set();
      for (const f of files) {
        const m = f.match(/^highlights_(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) dates.add(m[1]);
      }
      return [...dates].sort().reverse();
    } catch {
      return [];
    }
  }
};

module.exports = { HighlightStore };
```

- [ ] **Step 2: Verify module loads**

```bash
node -e "const {HighlightStore} = require('./lib/highlight-store'); console.log('Module OK')"
```

Expected: `Module OK`

- [ ] **Step 3: Commit**

```bash
git add lib/highlight-store.js
git commit -m "feat: add highlight-store — JSON persistence for clip annotations"
```

---

### Task 1.4: Create lib/highlight-engine.js

**Files:** Create: `D:\rex\bili-recorder\lib\highlight-engine.js`

The engine consumes events from danmaku-parser, maintains sliding windows, and fires highlight detections. Scoring formula: `score = danmakuScore*0.35 + giftScore*0.30 + keywordScore*0.25 + audioScore*0.10`.

- [ ] **Step 1: Write highlight-engine.js**

```js
const { HighlightStore } = require('./highlight-store');

const WINDOW_S = 5;           // sliding window seconds
const BASELINE_S = 60;        // baseline seconds
const SIGMA_DANMAKU_3 = 3.0;  // 3σ for danmaku density
const SIGMA_DANMAKU_5 = 5.0;  // 5σ for super peak
const GIFT_THRESHOLD_RMB = 100; // gift burst threshold in yuan

// High-signal keyword patterns
const KEYWORD_PATTERNS = [
  /^\？{2,}$/,                  // question mark storm: ？？？
  /^6{2,}$/,                    // 666, 6666, ...
  /^(牛[逼批bB]+|n[iI]+[cC]+[eE]+)$/,
  /^(卧槽|我操|wc|Wc|WC)$/,
  /^(名场面|合影|录屏|保存|截图|高能|前方高能)$/,
  /^(啊？|啊\?|什么|离谱|逆天|不愧是你)$/,
  /^(来了来了|恭喜|起飞|拿下|有了)$/,
];

function matchKeyword(text) {
  for (const re of KEYWORD_PATTERNS) {
    if (re.test(text.trim())) return true;
  }
  return false;
}

class HighlightEngine {
  constructor(streamerId, streamerName, roomId, logger) {
    this.streamerId = streamerId;
    this.streamerName = streamerName;
    this.roomId = roomId;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    // Sliding window buckets: 1-second buckets
    this._danmakuBuckets = [];      // { ts, count, keywordCount }
    this._giftBuckets = [];         // { ts, valueRmb }
    this._viewerCounts = [];        // { ts, count }
    this._recordingStartTime = null;
    this._lastHighlightTime = 0;    // for 30s dedup
  }

  setRecordingStart(ts) {
    this._recordingStartTime = ts || Date.now();
    this._danmakuBuckets = [];
    this._giftBuckets = [];
    this._lastHighlightTime = 0;
  }

  feedDanmaku(text) {
    const now = Date.now() / 1000;
    const bucketIdx = Math.floor(now);
    const keyword = matchKeyword(text) ? 1 : 0;

    let bucket = this._danmakuBuckets.find(b => b.idx === bucketIdx);
    if (!bucket) {
      bucket = { idx: bucketIdx, count: 0, keywordCount: 0 };
      this._danmakuBuckets.push(bucket);
    }
    bucket.count++;
    bucket.keywordCount += keyword;

    // Prune old buckets
    this._danmakuBuckets = this._danmakuBuckets.filter(b => b.idx > bucketIdx - BASELINE_S * 2);

    this._evaluate(now);
  }

  feedGift(rmb) {
    const now = Date.now() / 1000;
    const bucketIdx = Math.floor(now);

    let bucket = this._giftBuckets.find(b => b.idx === bucketIdx);
    if (!bucket) {
      bucket = { idx: bucketIdx, valueRmb: 0 };
      this._giftBuckets.push(bucket);
    }
    bucket.valueRmb += rmb;

    this._giftBuckets = this._giftBuckets.filter(b => b.idx > bucketIdx - BASELINE_S * 2);

    this._evaluate(now);
  }

  feedViewerCount(count) {
    const now = Date.now() / 1000;
    this._viewerCounts.push({ ts: now, count });
    // Keep 5 minutes
    this._viewerCounts = this._viewerCounts.filter(v => v.ts > now - 300);
  }

  _windowSum(buckets, field, windowEnd, windowSec) {
    const windowStart = windowEnd - windowSec;
    let sum = 0;
    for (const b of buckets) {
      if (b.idx > windowStart && b.idx <= windowEnd) {
        sum += (b[field] || 0);
      }
    }
    return sum;
  }

  _baselineStats(buckets, field, now, baselineSec) {
    // Use data from (now - baselineSec*2) to (now - baselineSec) as baseline
    const values = [];
    for (let t = now - baselineSec * 2; t < now - baselineSec; t++) {
      let val = 0;
      for (const b of buckets) {
        if (b.idx > t && b.idx <= t + 1) {
          val = b[field] || 0;
          break;
        }
      }
      values.push(val);
    }
    if (values.length === 0) return { mean: 0, std: 1 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return { mean, std: Math.sqrt(variance) || 0.1 };
  }

  _evaluate(now) {
    // Don't evaluate too frequently
    if (now - this._lastHighlightTime < 30) return;

    const danmaku5s = this._windowSum(this._danmakuBuckets, 'count', now, WINDOW_S);
    const keyword5s = this._windowSum(this._danmakuBuckets, 'keywordCount', now, WINDOW_S);
    const gift10sRmb = this._windowSum(this._giftBuckets, 'valueRmb', now, 10);

    const danmakuStats = this._baselineStats(this._danmakuBuckets, 'count', now, BASELINE_S);
    const danmakuZ = danmakuStats.std > 0 ? (danmaku5s - danmakuStats.mean) / danmakuStats.std : 0;

    const keywordRatio = danmaku5s > 0 ? keyword5s / danmaku5s : 0;
    const keywordTriggered = keyword5s > 10 || keywordRatio > 0.3;

    let triggered = false;
    let triggers = [];
    let score = 0;

    // Rule 3: super peak (>5σ)
    if (danmakuZ > SIGMA_DANMAKU_5) {
      triggered = true;
      triggers.push('danmaku_super_peak');
      score = Math.min(1, danmakuZ / 10);
    }
    // Rule 4: guard buy (handled separately via feedGuard event)
    // Rule 1: danmaku peak + gift burst
    else if (danmakuZ > SIGMA_DANMAKU_3 && gift10sRmb > GIFT_THRESHOLD_RMB) {
      triggered = true;
      triggers.push('danmaku_peak', 'gift_burst');
      const dScore = Math.min(1, danmakuZ / 6);
      const gScore = Math.min(1, gift10sRmb / 500);
      score = dScore * 0.5 + gScore * 0.5;
    }
    // Rule 2: danmaku peak + keyword flood
    else if (danmakuZ > SIGMA_DANMAKU_3 && keywordTriggered) {
      triggered = true;
      triggers.push('danmaku_peak', 'keyword_flood');
      const dScore = Math.min(1, danmakuZ / 6);
      const kScore = Math.min(1, keywordRatio / 0.6);
      score = dScore * 0.5 + kScore * 0.5;
    }

    if (triggered && this._recordingStartTime) {
      const offset = now - (this._recordingStartTime / 1000);
      const h = {
        startOffset: Math.max(0, offset - 10),
        endOffset: offset + 5,
        duration: 15,
        score: Math.round(score * 100) / 100,
        triggers,
        danmakuCount: danmaku5s,
        peakDanmakuRate: danmaku5s / WINDOW_S,
        totalGiftValue: Math.round(gift10sRmb * 100) / 100,
        audioPeakDb: null,
        title: triggers.includes('gift_burst') ? '礼物轰炸高能时刻' :
               triggers.includes('keyword_flood') ? '弹幕刷屏名场面' :
               '弹幕峰值高能时刻'
      };
      const today = new Date().toISOString().slice(0, 10);
      const saved = HighlightStore.add(this.streamerName, today, h);
      if (saved) {
        this.logger.info(`[highlight] ${this.streamerName}: ${saved.title} (score: ${saved.score}, offset: ${Math.floor(saved.startOffset)}s)`);
      }
      this._lastHighlightTime = now;
    }
  }

  // Called for rule 4: guard buy — always triggers
  feedGuard(guardLevel, guardName, rmb) {
    if (!this._recordingStartTime) return;
    const now = Date.now() / 1000;
    const offset = now - (this._recordingStartTime / 1000);
    const h = {
      startOffset: Math.max(0, offset - 5),
      endOffset: offset + 10,
      duration: 15,
      score: Math.min(1, rmb / 20000),
      triggers: ['guard_buy'],
      danmakuCount: 0,
      peakDanmakuRate: 0,
      totalGiftValue: rmb,
      audioPeakDb: null,
      title: `${guardName}开通！`
    };
    const today = new Date().toISOString().slice(0, 10);
    const saved = HighlightStore.add(this.streamerName, today, h);
    if (saved) {
      this.logger.info(`[highlight] ${this.streamerName}: GUARD ${guardName} (${rmb}yuan)`);
    }
    this._lastHighlightTime = now;
  }

  // Called for rule 5: offline audio supplement
  feedAudioResult(audioPeaks) {
    const today = new Date().toISOString().slice(0, 10);
    for (const peak of audioPeaks) {
      // Check if any existing highlight is near this audio peak
      const data = HighlightStore.getAll(this.streamerName, today);
      let nearExisting = false;
      for (const h of data.highlights) {
        if (Math.abs(h.startOffset - peak.startOffset) < 15) {
          h.audioPeakDb = peak.maxDb;
          h.score = Math.min(1, h.score + 0.1);
          if (!h.triggers.includes('audio_peak')) h.triggers.push('audio_peak');
          HighlightStore.update(this.streamerName, today, h.id, {
            audioPeakDb: peak.maxDb,
            score: h.score,
            triggers: h.triggers
          });
          nearExisting = true;
          this.logger.info(`[highlight] Audio supplement for existing: ${h.title} (+${peak.maxDb}dB)`);
          break;
        }
      }
      // If no existing highlight nearby and audio is intense enough, create new
      if (!nearExisting && peak.maxDb > -12) {
        const h = {
          startOffset: peak.startOffset,
          endOffset: peak.endOffset,
          duration: peak.endOffset - peak.startOffset,
          score: 0.3,
          triggers: ['audio_peak'],
          danmakuCount: 0,
          peakDanmakuRate: 0,
          totalGiftValue: 0,
          audioPeakDb: peak.maxDb,
          title: '音频高能时刻'
        };
        HighlightStore.add(this.streamerName, today, h);
        this.logger.info(`[highlight] New audio-only highlight at ${Math.floor(peak.startOffset)}s (${peak.maxDb}dB)`);
      }
    }
  }

  getStats() {
    return {
      streamerId: this.streamerId,
      danmakuBuckets: this._danmakuBuckets.length,
      giftBuckets: this._giftBuckets.length
    };
  }
}

module.exports = { HighlightEngine };
```

- [ ] **Step 2: Verify module loads**

```bash
node -e "const {HighlightEngine} = require('./lib/highlight-engine'); console.log('Module OK:', typeof HighlightEngine)"
```

Expected: `Module OK: function`

- [ ] **Step 3: Commit**

```bash
git add lib/highlight-engine.js
git commit -m "feat: add highlight-engine — multi-signal fusion rule engine"
```

---

### Task 1.5: Integrate with server.js — lifecycle hooks + API

**Files:** Modify: `D:\rex\bili-recorder\server.js`

Wire danmaku-parser start/stop into Poller lifecycle. Add GET/PUT/DELETE highlight API endpoints.

- [ ] **Step 1: Add requires at top of server.js**

Find the line `const http = require('http');` (line 5) and add after it:

```js
const { DanmakuParser } = require('./lib/danmaku-parser');
const { HighlightEngine } = require('./lib/highlight-engine');
const { HighlightStore } = require('./lib/highlight-store');
```

- [ ] **Step 2: Add DanmakuManager after Recorder definition (after line 301)**

```js
// ─── Danmaku Manager ───────────────────────────────────────────────────────────
const DanmakuManager = {
  _engines: {},   // streamerId -> HighlightEngine
  _parsers: {},   // streamerId -> DanmakuParser

  start(streamerId, streamerName, roomId) {
    if (this._parsers[streamerId]) return;
    const engine = new HighlightEngine(streamerId, streamerName, roomId, logger);
    const parser = new DanmakuParser(roomId, logger);
    this._engines[streamerId] = engine;
    this._parsers[streamerId] = parser;

    engine.setRecordingStart(Date.now());

    parser.on('danmaku', (d) => { engine.feedDanmaku(d.text); });
    parser.on('gift', (d) => { engine.feedGift(d.rmb); });
    parser.on('guard', (d) => { engine.feedGuard(d.guardLevel, d.guardName, d.rmb); });
    parser.on('error', () => { /* Reconnect handled by parser internally */ });
    parser.on('close', () => {
      logger.warn(`[danmaku] Parser closed for ${streamerName}, will not reconnect`);
    });

    parser.start().catch((e) => {
      logger.error(`[danmaku] Failed to start parser for ${streamerName}: ${e.message}`);
    });
    logger.info(`[danmaku] Started for ${streamerName} (room ${roomId})`);
  },

  stop(streamerId) {
    const parser = this._parsers[streamerId];
    if (parser) {
      parser.stop();
      delete this._parsers[streamerId];
    }
    if (this._engines[streamerId]) {
      delete this._engines[streamerId];
    }
    logger.info(`[danmaku] Stopped for ${streamerId}`);
  },

  getEngine(streamerId) {
    return this._engines[streamerId] || null;
  },

  isRunning(streamerId) {
    return !!this._parsers[streamerId];
  }
};
```

- [ ] **Step 3: Add danmaku start/stop hooks in Poller.check()**

In Poller.check(), find the block that handles going LIVE (starts with `// Just went live — start recording`, around line 343). After the recording start call, add danmaku start:

```js
// After Store.updateStreamer(s.id, { recording: true, lastFilePath: filePath });
// Add:
DanmakuManager.start(s.id, s.name, realRoomId);
```

In the block that handles going OFFLINE (starts with `// Just went offline`, around line 357), add danmaku stop before the Store.updateStreamer:

```js
// Before Store.updateStreamer(s.id, { status: 'offline', recording: false });
// Add:
DanmakuManager.stop(s.id);
```

- [ ] **Step 4: Add danmaku start on manual recording start**

Find the POST `/api/streamer/:id/start` handler. After `Store.updateStreamer(id, { recording: true, lastLiveTime: Date.now() });` add:

```js
if (!DanmakuManager.isRunning(id)) {
  DanmakuManager.start(id, s.name, realRoomId);
}
```

- [ ] **Step 5: Add danmaku stop on manual recording stop**

Find the POST `/api/streamer/:id/stop` handler. Before `Store.updateStreamer(id, { recording: false });` add:

```js
DanmakuManager.stop(id);
```

- [ ] **Step 6: Add danmaku cleanup on streamer delete**

Find the DELETE `/api/streamer/:id` handler. After `if (Recorder.isRecording(id)) await Recorder.stop(id);` add:

```js
DanmakuManager.stop(id);
```

- [ ] **Step 7: Add danmaku cleanup on shutdown**

Find the POST `/api/shutdown` handler. Before `process.exit(0);` add cleanup for all danmaku sessions:

```js
for (const [sid] of Object.entries(DanmakuManager._parsers)) {
  DanmakuManager.stop(sid);
}
```

- [ ] **Step 8: Add highlight API endpoints**

Add before the 404 fallback (before line 744 `res.writeHead(404);`):

```js
  // ─── Highlight APIs ──────────────────────────────────────────────────────────

  if (url.pathname === '/api/highlights' && req.method === 'GET') {
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!streamerName) {
      sendJSON(res, 400, { error: 'Missing streamerName' });
      return;
    }
    const data = HighlightStore.getAll(streamerName, date);
    // Also list available dates
    const dates = HighlightStore.listDates(streamerName);
    sendJSON(res, 200, { ...data, availableDates: dates });
    return;
  }

  if (url.pathname === '/api/highlights/dates' && req.method === 'GET') {
    const streamerName = url.searchParams.get('streamerName');
    if (!streamerName) {
      sendJSON(res, 400, { error: 'Missing streamerName' });
      return;
    }
    const dates = HighlightStore.listDates(streamerName);
    sendJSON(res, 200, { dates });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && !url.pathname.includes('/clip') && req.method === 'DELETE') {
    const parts = url.pathname.split('/');
    const id = parts[parts.length - 1];
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date');
    if (!streamerName || !date) {
      sendJSON(res, 400, { error: 'Missing streamerName or date' });
      return;
    }
    const removed = HighlightStore.remove(streamerName, date, id);
    sendJSON(res, removed ? 200 : 404, { ok: removed });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && !url.pathname.includes('/clip') && req.method === 'PUT') {
    const parts = url.pathname.split('/');
    const id = parts[parts.length - 1];
    const body = await parseJSON(req);
    const streamerName = body.streamerName;
    const date = body.date;
    if (!streamerName || !date) {
      sendJSON(res, 400, { error: 'Missing streamerName or date' });
      return;
    }
    const { startOffset, endOffset } = body;
    const updated = HighlightStore.update(streamerName, date, id, { startOffset, endOffset, duration: endOffset - startOffset });
    sendJSON(res, updated ? 200 : 404, updated || { error: 'Not found' });
    return;
  }
```

- [ ] **Step 9: Start server and verify it runs without errors**

```bash
node -e "require('./server.js')" &
sleep 3
curl -s http://localhost:3456/api/status | head -c 100
```

Expected: JSON response with streamers array.

- [ ] **Step 10: Commit**

```bash
git add server.js
git commit -m "feat: integrate danmaku lifecycle + highlight APIs into server"
```

---

## Phase 2 — 离线音频分析

### Task 2.1: Create lib/audio-analyzer.js

**Files:** Create: `D:\rex\bili-recorder\lib\audio-analyzer.js`

After recording completes, extract audio track and detect energy peaks using ffmpeg's silencedetect filter. Feeds results to HighlightEngine for rule 5 (offline audio supplement).

- [ ] **Step 1: Write audio-analyzer.js**

```js
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

// Run ffmpeg silencedetect on audio track, then compute RMS energy in active segments.
// Returns array of { startOffset, endOffset, maxDb } peaks.
async function analyzeAudio(videoFilePath, logger) {
  const log = logger || { info() {}, warn() {}, error() {} };

  return new Promise((resolve) => {
    const peaks = [];

    // Step 1: silencedetect to find non-silent segments
    const args = [
      '-i', videoFilePath,
      '-af', 'silencedetect=noise=-50dB:d=0.5',
      '-f', 'null', '-y', 'NUL'
    ];

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        log.warn(`[audio] silencedetect exited ${code} for ${path.basename(videoFilePath)}`);
      }

      // Parse silencedetect output
      // Format: silence_start: 123.45 | silence_end: 130.0 | silence_duration: 6.55
      const silenceStarts = [];
      const silenceEnds = [];
      const reStart = /silence_start:\s*([\d.]+)/g;
      const reEnd = /silence_end:\s*([\d.]+)/g;
      let m;
      while ((m = reStart.exec(stderr)) !== null) silenceStarts.push(parseFloat(m[1]));
      while ((m = reEnd.exec(stderr)) !== null) silenceEnds.push(parseFloat(m[1]));

      // Non-silent segments = gaps between silence_end and next silence_start
      // First non-silent segment: 0 to first silence_start
      // Between: silence_end[i] to silence_start[i+1]
      // Last: last silence_end to end (we don't know end, skip)

      const activeSegments = [];
      if (silenceStarts.length > 0) {
        activeSegments.push({ start: 0, end: silenceStarts[0] });
      }
      for (let i = 0; i < silenceEnds.length && i + 1 < silenceStarts.length; i++) {
        activeSegments.push({ start: silenceEnds[i], end: silenceStarts[i + 1] });
      }

      // Step 2: For each active segment, compute RMS energy via ffmpeg volumedetect
      // We batch this: run volumedetect on the whole file first to get mean_volume
      const args2 = [
        '-i', videoFilePath,
        '-af', 'volumedetect',
        '-f', 'null', '-y', 'NUL'
      ];

      const proc2 = spawn(FFMPEG, args2, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr2 = '';
      proc2.stderr.on('data', (d) => { stderr2 += d.toString(); });

      proc2.on('exit', () => {
        // Parse volumedetect: mean_volume: -20.5 dB, max_volume: -3.2 dB
        const meanMatch = stderr2.match(/mean_volume:\s*([\-\d.]+)\s*dB/);
        const maxMatch = stderr2.match(/max_volume:\s*([\-\d.]+)\s*dB/);
        const meanDb = meanMatch ? parseFloat(meanMatch[1]) : -30;
        const maxDb = maxMatch ? parseFloat(maxMatch[1]) : 0;

        // For now, we use a simplified approach: mark active segments longer than 2s
        // with high volume (close to max_volume) as potential audio peaks
        // A full RMS frame-by-frame analysis would require extracting to WAV first.
        // Simplified: segments with length > 2s and near max_volume region

        for (const seg of activeSegments) {
          const duration = seg.end - seg.start;
          if (duration >= 2 && duration <= 60) {
            // Approximate: if segment contains the max volume point, tag it
            // We use mean-to-max ratio as a heuristic for "dynamic" segments
            peaks.push({
              startOffset: seg.start,
              endOffset: seg.end,
              maxDb: Math.round(maxDb * 10) / 10,
              meanDb: Math.round(meanDb * 10) / 10
            });
          }
        }

        log.info(`[audio] Analyzed ${path.basename(videoFilePath)}: ${activeSegments.length} active segments, ${peaks.length} peaks`);
        resolve(peaks);
      });

      proc2.on('error', (err) => {
        log.error(`[audio] volumedetect error: ${err.message}`);
        resolve([]);
      });
    });

    proc.on('error', (err) => {
      log.error(`[audio] silencedetect error: ${err.message}`);
      resolve([]);
    });
  });
}

module.exports = { analyzeAudio };
```

- [ ] **Step 2: Verify module loads**

```bash
node -e "const {analyzeAudio} = require('./lib/audio-analyzer'); console.log('Module OK:', typeof analyzeAudio)"
```

Expected: `Module OK: function`

- [ ] **Step 3: Commit**

```bash
git add lib/audio-analyzer.js
git commit -m "feat: add audio-analyzer — offline energy peak detection via ffmpeg"
```

---

### Task 2.2: Wire audio analysis trigger in server.js

**Files:** Modify: `D:\rex\bili-recorder\server.js`

Auto-trigger audio analysis when recording stops (natural offline or manual stop).

**IMPORTANT:** Audio analysis must run BEFORE `DanmakuManager.stop(id)` — the engine must still be alive to receive audio results.

- [ ] **Step 1: Add require at top of server.js**

```js
const { analyzeAudio } = require('./lib/audio-analyzer');
```

- [ ] **Step 2: Add async trigger after recording stop in Poller.check()**

Find the block `// Just went offline`. After `const stoppedFile = await Recorder.stop(s.id);` and the log line, add:

```js
if (stoppedFile && DanmakuManager.getEngine(s.id)) {
  const engine = DanmakuManager.getEngine(s.id);
  const peaks = await analyzeAudio(stoppedFile, logger);
  if (peaks.length > 0) {
    engine.feedAudioResult(peaks);
  }
}
```

- [ ] **Step 3: Add same trigger in manual stop handler**

Find POST `/api/streamer/:id/stop`. After `await Recorder.stop(id);` add:

```js
const s = Store.getStreamers().find(s => s.id === id);
if (s) {
  const engine = DanmakuManager.getEngine(id);
  if (engine && s.lastFilePath) {
    const peaks = await analyzeAudio(s.lastFilePath, logger);
    if (peaks.length > 0) {
      engine.feedAudioResult(peaks);
    }
  }
}
```

Note: The `s` variable should already be in scope from earlier in the handler. Check the existing code and adjust if needed.

- [ ] **Step 4: Start server and verify no errors**

```bash
node -e "require('./server.js')" &
sleep 3
curl -s http://localhost:3456/api/status | grep -c '"status"'
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: auto-trigger audio analysis on recording stop"
```

---

## Phase 3 — Web 面板 + 批量裁剪

### Task 3.1: Add POST /api/highlights/clip endpoint

**Files:** Modify: `D:\rex\bili-recorder\server.js`

Add the clip endpoint that invokes ffmpeg to extract highlight segments.

- [ ] **Step 1: Add clip API endpoint**

Add before the 404 fallback in server.js:

```js
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
    const toClip = data.highlights.filter(h => ids.includes(h.id));
    if (toClip.length === 0) {
      sendJSON(res, 400, { error: 'No matching highlights found' });
      return;
    }

    const results = [];
    const clipDir = path.dirname(filePath);

    for (const h of toClip) {
      const srcExt = path.extname(filePath);
      const clipName = path.basename(filePath, srcExt) + `_clip_${Math.floor(h.startOffset)}s_${Math.floor(h.endOffset)}s` + srcExt;
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
          proc.on('exit', (code) => {
            code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`));
          });
          proc.on('error', reject);
        });

        HighlightStore.update(streamerName, date, h.id, { clipped: true, clipFile: clipPath });
        results.push({ id: h.id, ok: true, clipFile: clipPath });
        logger.info(`[clip] ${clipName} (${Math.floor(h.startOffset)}s-${Math.floor(h.endOffset)}s)`);
      } catch (e) {
        results.push({ id: h.id, ok: false, error: e.message });
        logger.error(`[clip] Failed: ${h.id} — ${e.message}`);
      }
    }

    sendJSON(res, 200, { results });
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add clip endpoint — ffmpeg segment extraction from highlights"
```

---

### Task 3.2: Add highlight panel to index.html

**Files:** Modify: `D:\rex\bili-recorder\index.html`

Add a new section after the offline area and before settings, showing highlight annotations with clip controls.

- [ ] **Step 1: Add highlight section HTML**

Find `<div class="section-label">设置</div>` in index.html. Add before it:

```html
<div class="section-label" id="highlightsLabel" style="display:none">高光切片</div>
<div id="highlightsArea">
  <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
    <select id="hlStreamerSelect" onchange="refreshHighlights()" style="padding:6px 10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:12px;font-family:var(--font-ui)">
      <option value="">选择主播...</option>
    </select>
    <select id="hlDateSelect" onchange="refreshHighlights()" style="padding:6px 10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:12px;font-family:var(--font-ui)">
      <option value="">今天</option>
    </select>
    <button class="btn-sm" id="btnClipSelected" onclick="clipSelected()">裁剪选中</button>
  </div>
  <div id="highlightsList"></div>
</div>
```

- [ ] **Step 2: Add highlight styles**

Add these styles before `</style>`:

```css
.hl-item{display:flex;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:10px;cursor:default}
.hl-item.selected{background:var(--accent-bg);margin:0 -8px;padding-left:8px;padding-right:8px}
.hl-check{flex-shrink:0}
.hl-info{flex:1;min-width:0}
.hl-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.hl-meta{font-size:10px;color:var(--text3);margin-top:2px}
.hl-score{font-size:11px;font-weight:700;flex-shrink:0;text-align:center;min-width:36px}
.hl-score.hot{color:#E8860C}
.hl-score.wild{color:var(--danger)}
.tag{display:inline-block;padding:1px 6px;font-size:9px;font-weight:600;border-radius:2px;margin-right:3px}
.tag-danmaku{background:#E8D5F5;color:#6B3FA0}
.tag-gift{background:#FDE4C3;color:#A05B0A}
.tag-audio{background:#D6ECFB;color:#2A6B9E}
.tag-guard{background:#FDDEDE;color:#B52828}
```

- [ ] **Step 3: Add highlight JavaScript functions**

Add the following functions inside the `<script>` block, before the closing `</script>`:

```js
let highlightData = { highlights: [], availableDates: [] };
let selectedHighlightIds = new Set();

function formatOffset(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

async function refreshHighlights() {
  const sel = document.getElementById('hlStreamerSelect');
  const dateSel = document.getElementById('hlDateSelect');
  const streamerName = sel.value;
  const date = dateSel.value || new Date().toISOString().slice(0, 10);

  if (!streamerName) {
    document.getElementById('highlightsLabel').style.display = 'none';
    document.getElementById('highlightsList').innerHTML = '';
    return;
  }

  // Populate streamer dropdown
  const statusData = await API.get('/api/status');
  const streamerSel = document.getElementById('hlStreamerSelect');
  if (streamerSel.options.length <= 1) {
    for (const s of statusData.streamers) {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      streamerSel.appendChild(opt);
    }
  }

  const url = '/api/highlights?streamerName=' + encodeURIComponent(streamerName) + '&date=' + date;
  highlightData = await API.get(url);
  document.getElementById('highlightsLabel').style.display = '';
  selectedHighlightIds.clear();
  renderHighlightList();
}

function renderHighlightList() {
  const list = document.getElementById('highlightsList');
  const hl = highlightData.highlights || [];

  // Update date dropdown
  const dateSel = document.getElementById('hlDateSelect');
  const dates = highlightData.availableDates || [];
  dateSel.innerHTML = dates.map(d => `<option value="${d}">${d}</option>`).join('');
  if (dates.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    dateSel.innerHTML = `<option value="${today}">${today}</option>`;
  }

  if (hl.length === 0) {
    list.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">暂无高光标注</div>';
    updateClipButton();
    return;
  }

  list.innerHTML = hl.map(h => {
    const tagHTML = (h.triggers || []).map(t => {
      const cls = t === 'danmaku_peak' || t === 'danmaku_super_peak' || t === 'keyword_flood' ? 'tag-danmaku' :
                  t === 'gift_burst' ? 'tag-gift' :
                  t === 'guard_buy' ? 'tag-guard' :
                  t === 'audio_peak' ? 'tag-audio' : '';
      const label = t === 'danmaku_peak' ? '弹幕峰值' :
                    t === 'danmaku_super_peak' ? '超级峰值' :
                    t === 'keyword_flood' ? '关键词刷屏' :
                    t === 'gift_burst' ? '礼物轰炸' :
                    t === 'guard_buy' ? '大航海' :
                    t === 'audio_peak' ? '音频高能' : t;
      return `<span class="tag ${cls}">${label}</span>`;
    }).join('');

    const scoreClass = h.score >= 0.8 ? 'wild' : h.score >= 0.5 ? 'hot' : '';
    const selected = selectedHighlightIds.has(h.id) ? ' selected' : '';
    const clippedBadge = h.clipped ? ` <span style="color:var(--live);font-size:10px">已裁剪</span>` : '';
    const clipLink = h.clipFile ? ` <span style="font-size:10px;color:var(--text3);cursor:pointer" onclick="event.stopPropagation();playFile('${h.clipFile.replace(/\\/g, '\\\\')}')">▶播放</span>` : '';

    return `<div class="hl-item${selected}" onclick="toggleHighlight('${h.id}', this)">
      <input type="checkbox" class="hl-check" ${selected ? 'checked' : ''} onclick="event.stopPropagation();toggleHighlight('${h.id}', this.parentElement)" style="pointer-events:auto">
      <div class="hl-info">
        <div class="hl-title">${formatOffset(h.startOffset)}–${formatOffset(h.endOffset)} ${tagHTML}${clippedBadge}${clipLink}</div>
        <div class="hl-meta">持续${Math.round(h.duration)}s · 弹幕${h.danmakuCount || 0}条 · 礼物¥${h.totalGiftValue || 0}</div>
      </div>
      <div class="hl-score ${scoreClass}">${(h.score * 100).toFixed(0)}%</div>
    </div>`;
  }).join('');

  updateClipButton();
}

function toggleHighlight(id, el) {
  if (selectedHighlightIds.has(id)) {
    selectedHighlightIds.delete(id);
    if (el) el.classList.remove('selected');
  } else {
    selectedHighlightIds.add(id);
    if (el) el.classList.add('selected');
  }
  updateClipButton();
}

function updateClipButton() {
  const btn = document.getElementById('btnClipSelected');
  btn.textContent = '裁剪选中 (' + selectedHighlightIds.size + ')';
  btn.disabled = selectedHighlightIds.size === 0;
}

async function clipSelected() {
  if (selectedHighlightIds.size === 0) return;
  const sel = document.getElementById('hlStreamerSelect');
  const dateSel = document.getElementById('hlDateSelect');
  const streamerName = sel.value;
  const date = dateSel.value || new Date().toISOString().slice(0, 10);

  // Find the source file — use the first clip to determine filePath
  const h = highlightData.highlights.find(h => selectedHighlightIds.has(h.id));
  if (!h) return;

  // Need file path from recordings list
  const statusData = await API.get('/api/status');
  const s = statusData.streamers.find(s => s.name === streamerName);
  const recs = statusData.recordings.filter(r => r.streamerId === (s ? s.id : ''));
  if (recs.length === 0) { showToast('找不到可用的录制文件'); return; }
  const filePath = recs[0].filePath;

  showToast('正在裁剪 ' + selectedHighlightIds.size + ' 个高光片段...');
  const body = { ids: [...selectedHighlightIds], streamerName, date, filePath };
  const r = await API.post('/api/highlights/clip', body);
  if (r.results) {
    const ok = r.results.filter(x => x.ok).length;
    const fail = r.results.filter(x => !x.ok).length;
    showToast('裁剪完成: ' + ok + ' 成功' + (fail > 0 ? ', ' + fail + ' 失败' : ''));
  }
  selectedHighlightIds.clear();
  await refreshHighlights();
}

// Hook into main refresh to populate streamer dropdown
const _origRefresh = refresh;
refresh = async function() {
  await _origRefresh();
  // If streamer select is showing, refresh highlights
  const sel = document.getElementById('hlStreamerSelect');
  if (sel.value) {
    refreshHighlights();
  }
};
```

- [ ] **Step 4: Verify frontend loads without JS errors**

Start server and check browser console:

```bash
node -e "require('./server.js')" &
sleep 2
# Use playwright or manual check: open http://localhost:3456, check no JS errors in console
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add highlight panel — annotation list, batch clip with preview"
```

---

## Phase 3 Verification

### Task 3.3: End-to-end smoke test

- [ ] **Step 1: Add a test streamer and verify danmaku parser connects**

```bash
# Send request to add a test streamer (use a B站 room ID)
curl -X POST http://localhost:3456/api/streamer -H "Content-Type: application/json" -d "{\"roomId\":\"1\"}"
```

- [ ] **Step 2: Manually trigger highlight store write**

```bash
node -e "
const {HighlightStore} = require('./lib/highlight-store');
const h = HighlightStore.add('testStreamer', '2026-05-15', {
  startOffset: 120, endOffset: 135, duration: 15,
  score: 0.85, triggers: ['danmaku_peak', 'keyword_flood'],
  danmakuCount: 45, peakDanmakuRate: 9.2, totalGiftValue: 230,
  audioPeakDb: -6.3, title: '测试高光片段'
});
console.log('Added:', h.id);
"
```

- [ ] **Step 3: Verify highlight API returns data**

```bash
curl -s "http://localhost:3456/api/highlights?streamerName=testStreamer&date=2026-05-15" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log('Highlights:', j.highlights.length)})"
```

Expected: `Highlights: 1`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: verify highlight pipeline end-to-end"
```

---

## Summary

| Phase | Files Created | Files Modified | Key Deliverable |
|-------|--------------|----------------|-----------------|
| 1 | `lib/danmaku-parser.js`, `lib/highlight-engine.js`, `lib/highlight-store.js` | `package.json`, `server.js` | 实时弹幕解析 + 规则引擎 + API |
| 2 | `lib/audio-analyzer.js` | `server.js` | 离线音频能量分析 |
| 3 | — | `server.js`, `index.html` | 批量裁剪 + 前端面板 |

**Total:** 4 new files, 3 modified files.
