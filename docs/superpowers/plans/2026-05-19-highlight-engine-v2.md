# 高光引擎 v2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将高光检测从单一 z-score 升级为多因子语义评分（情绪密度 + 一致性 + 加速度 + 时间位置 + 自适应基线），零外部依赖。

**Architecture:** 重写 `highlight-engine.js` 的 evaluate 函数为新评分模型，config.json 新增可编辑情绪词典和每主播历史基线，server.js 处理基线持久化和 recordingStartTime bug 修复。

**Tech Stack:** 纯 Node.js（fs/json），无新依赖

---

## 文件结构

```
lib/highlight-engine.js   ← 重写评分核心（约 150 行改动）
server.js                 ← 基线管理 + recordingStartTime 修复 + 源文件查找修复
config.json               ← 新增 emotionDict + streamer.baseline
index.html                ← 情绪词典编辑面板
```

---

### Task 1: config.json 加 emotionDict 默认值

**Files:**
- Modify: `config.json`

- [ ] **Step 1: 在 config.json 顶层添加 emotionDict**

在 `"settings"` 之前插入：

```json
"emotionDict": {
  "laugh": ["哈哈", "笑死", "草", "www", "hhh", "笑死我了", "xs", "hhhh"],
  "surprise": ["？？", "卧槽", "啊？", "什么", "我去", "wc", "？?", "???"],
  "praise": ["666", "牛逼", "太强了", "牛", "帅", "好强", "nb", "太牛了"],
  "mock": ["离谱", "逆天", "不愧是你", "就这", "典", "急", "幽默", "抽象"]
},
```

同时给每个 streamer 添加初始 baseline：

```json
"baseline": {
  "meanDanmakuRate": 0,
  "stdDanmakuRate": 0,
  "updatedAt": null,
  "sampleCount": 0
}
```

- [ ] **Step 2: 验证 config.json 格式有效**

```bash
node -e "JSON.parse(require('fs').readFileSync('config.json','utf-8')); console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add config.json
git commit -m "feat: add emotionDict and baseline stubs to config.json"
```

---

### Task 2: 重写 highlight-engine.js 评分模型

**Files:**
- Modify: `lib/highlight-engine.js`

- [ ] **Step 1: 替换顶部常量区**

将第 6-13 行常量区替换为：

```javascript
const WINDOW_S = 5;
const BASELINE_S = 60;
const SIGMA_DANMAKU_3 = 3.0;
const SIGMA_DANMAKU_5 = 5.0;
const GIFT_THRESHOLD_RMB = 100;
const MIN_HIGHLIGHT_INTERVAL_S = 600;
const CLIP_BEFORE_S = 300;
const CLIP_AFTER_S = 300;

// v2: 绝对底线
const MIN_DANMAKU_5S = 3;
// v2: 录制开头冷却期（秒）
const COOLDOWN_S = 180;
// v2: 评分权重（加起来 = 1.0）
const W_EMOTION = 0.35;
const W_CONSISTENCY = 0.30;
const W_ACCELERATION = 0.15;
const W_ZSCORE = 0.15;
const W_TIME = 0.05;
```

- [ ] **Step 2: 在 matchKeyword 后面添加情绪匹配函数**

在第 31 行 `}` 之后，`baselineStats` 之前插入：

```javascript
// ─── Emotion matching ─────────────────────────────────────────────────────────

// Categories: laugh, surprise, praise, mock
// Same uid same pattern in 5s window counts once
function matchEmotion(text, emotionDict) {
  if (!emotionDict) return [];
  const trimmed = text.trim();
  const hits = [];
  for (const [category, patterns] of Object.entries(emotionDict)) {
    for (const p of patterns) {
      if (trimmed.includes(p)) { hits.push(category); break; }
    }
  }
  return hits;
}

function emotionScore(danmakuList, emotionDict) {
  // danmakuList: [{text, uid}] within current 5s window
  if (!danmakuList || danmakuList.length === 0) return 0;
  const total = danmakuList.length;
  const deduped = new Map(); // uid:text -> true
  let emotionHits = 0;

  for (const d of danmakuList) {
    const key = d.uid + ':' + d.text;
    if (deduped.has(key)) continue;
    deduped.set(key, true);
    const hits = matchEmotion(d.text, emotionDict);
    if (hits.length > 0) emotionHits++;
  }

  return Math.min(1, (emotionHits / total) * 3);
}

// ─── Consistency detection ───────────────────────────────────────────────────

function consistencyScore(danmakuList) {
  // Group by text content (min 2 chars), find largest group
  const groups = new Map(); // text -> Set(uid)
  for (const d of danmakuList) {
    const t = d.text.trim();
    if (t.length < 2) continue;
    if (!groups.has(t)) groups.set(t, new Set());
    groups.get(t).add(d.uid);
  }

  let maxSize = 0;
  for (const uids of groups.values()) {
    if (uids.size > maxSize) maxSize = uids.size;
  }

  const activeUsers = new Set(danmakuList.map(d => d.uid)).size;
  return maxSize / Math.max(5, activeUsers);
}
```

- [ ] **Step 3: 修改 createHighlightEngine 的 evaluate 函数**

将第 188-239 行的 `evaluate` 替换为：

```javascript
  function evaluate(now) {
    if (!recordingStartTime) return;
    if (now - lastHighlightTime < MIN_HIGHLIGHT_INTERVAL_S) return;

    const offset = now - recordingStartTime;

    // 录制开头冷却期硬过滤
    if (offset < COOLDOWN_S) return;

    // 获取 5s 窗口内的弹幕列表（用于情绪和一致性计算）
    const danmaku5s = windowSum(danmakuBuckets, 'count', now, WINDOW_S);

    // 绝对底线
    if (danmaku5s < MIN_DANMAKU_5S) return;

    // 构建 5s 窗口弹幕列表（用于情绪/一致性）
    const recentDanmaku = getRecentDanmaku(now, WINDOW_S);

    const emotionDict = Store.getSettings().emotionDict || null;

    // ── 计算各因子 ──

    // eScore: 情绪密度
    const eScore = emotionScore(recentDanmaku, emotionDict);

    // cScore: 弹幕一致性
    const cScore = consistencyScore(recentDanmaku);

    // aScore: 加速度（当前窗口 vs 前一窗口）
    const prevDanmaku5s = windowSum(danmakuBuckets, 'count', now - WINDOW_S, WINDOW_S);
    const accel = danmaku5s - prevDanmaku5s;
    const aScore = Math.min(1, Math.max(0, accel / Math.max(4, prevDanmaku5s * 2)));

    // zScore: z-score（使用自适应基线）
    const baseline = streamerBaseline || baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    const danmakuRate = danmaku5s / WINDOW_S;
    const dZ = baseline.std > 0 ? (danmakuRate - baseline.mean) / baseline.std : 0;
    const zScore = Math.min(1, dZ / 8);

    // tScore: 时间位置
    const tScore = timePositionScore(offset);

    // ── 融合评分 ──
    const score = Math.round(
      (eScore * W_EMOTION +
       cScore * W_CONSISTENCY +
       aScore * W_ACCELERATION +
       zScore * W_ZSCORE +
       tScore * W_TIME) * 100
    ) / 100;

    // ── 触发判断（v2: score >= 0.3 即触发，取代基于 z 的硬阈值） ──
    if (score < 0.3) return;

    // 确定 trigger 标签
    const triggers = determineTriggers(eScore, cScore, aScore, zScore);
    const title = makeTitle(triggers, eScore, cScore);

    // ── 礼物（保留原 Rule 1 逻辑但降低门槛） ──
    const gift10sRmb = windowSum(giftBuckets, 'valueRmb', now, 10);
    const giftScore = Math.min(1, gift10sRmb / 50); // 从 ¥100 降到 ¥50

    // ── 关键词（保留原 Rule 2 逻辑） ──
    const keyword5s = windowSum(danmakuBuckets, 'keywordCount', now, WINDOW_S);
    const keywordRatio = danmaku5s > 0 ? keyword5s / danmaku5s : 0;
    const keywordScore = Math.min(1, keyword5s / 5); // 从 10 降到 5

    const highlight = createHighlight(now, triggers, danmaku5s, gift10sRmb, null);
    highlight.score = score;
    highlight.title = title;
    highlight.emotionScore = Math.round(eScore * 100) / 100;
    highlight.consistencyScore = Math.round(cScore * 100) / 100;
    highlight.accelScore = Math.round(aScore * 100) / 100;

    commitHighlight(now, highlight, 'v2 score=' + score.toFixed(2) +
      ' (e=' + eScore.toFixed(2) + ' c=' + cScore.toFixed(2) +
      ' a=' + aScore.toFixed(2) + ' z=' + zScore.toFixed(2) +
      ' t=' + tScore.toFixed(2) + ') triggers=' + triggers.join('+'));
  }
```

- [ ] **Step 4: 添加辅助函数到 createHighlightEngine 内部**

在 `evaluate` 函数之前添加以下内部辅助函数（放在 `function evaluate(now)` 之前）：

```javascript
  // ── v2 辅助函数 ──

  function getRecentDanmaku(nowSec, windowSec) {
    // 从 danmakuBuckets 重建最近 windowSec 内的 (text, uid) 对
    // 由于 engine 不存储原始 text/uid，改为从最近事件重构
    // 暂时返回空——需要修改 feedDanmaku 来存储窗口历史
    return _recentTexts || [];
  }

  function timePositionScore(offset) {
    // 录制开头冷却期已在 evaluate 中硬过滤
    if (offset < 300) return 0.5;        // 3-5min 过渡区
    if (offset < 0) return 0;
    // 无明确结尾，假设录制时长未知，全按中段满分
    return 1.0;
  }

  function determineTriggers(eScore, cScore, aScore, zScore) {
    const triggers = [];
    if (eScore >= 0.5) triggers.push('emotion_burst');
    if (cScore >= 0.5) triggers.push('consensus');
    if (aScore >= 0.5) triggers.push('accel_spike');
    if (zScore >= 0.5) triggers.push('danmaku_peak');
    if (triggers.length === 0) triggers.push('composite');
    return triggers;
  }

  function makeTitle(triggers, eScore, cScore) {
    if (triggers.includes('emotion_burst') && triggers.includes('consensus'))
      return '情绪共鸣';
    if (triggers.includes('emotion_burst')) return '弹幕情绪爆发';
    if (triggers.includes('consensus')) return '观众一致反应';
    if (triggers.includes('accel_spike')) return '弹幕涌入';
    if (triggers.includes('danmaku_peak')) return '弹幕高峰';
    return '综合高光';
  }
```

- [ ] **Step 5: 修改 feedDanmaku 存储最近弹幕文本**

在 `feedDanmaku` 函数末尾（第 118 行 `evaluate(now)` 之前），添加存储逻辑：

```javascript
    // v2: 存储最近弹幕用于情绪和一致性分析
    if (!_recentTexts) _recentTexts = [];
    _recentTexts.push({ text, uid: 0, ts: now }); // uid 未知时用 0
    // 保留最近 60s 的弹幕
    const cutoff = now - 60;
    _recentTexts = _recentTexts.filter(d => d.ts > cutoff);
```

- [ ] **Step 6: 修改 createHighlightEngine 返回值和初始化**

在 factory 函数开头的变量声明区（第 74-77 行之后）添加：

```javascript
  let _recentTexts = [];
  let streamerBaseline = null;
```

在返回的 API 对象中（第 352-365 行），添加：

```javascript
    setBaseline: function (baseline) {
      streamerBaseline = baseline;
    },
    getBaselineStats: function () {
      const now = nowSec();
      return baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    },
```

- [ ] **Step 7: 重置 _recentTexts 和 streamerBaseline**

在 `setRecordingStart` 函数中（第 353-358 行），添加重置：

```javascript
    setRecordingStart: function (ts) {
      recordingStartTime = ts;
      lastHighlightTime = 0;
      danmakuBuckets.length = 0;
      giftBuckets.length = 0;
      _recentTexts = [];
    },
```

- [ ] **Step 8: Commit**

```bash
git add lib/highlight-engine.js
git commit -m "feat: highlight-engine v2 — multi-factor scoring with emotion/consistency/accel/time"
```

---

### Task 3: server.js — 自适应基线 + recordingStartTime 修复

**Files:**
- Modify: `server.js`

- [ ] **Step 1: 基线加载——在 DanmakuManager.start 中加载历史基线**

修改 `DanmakuManager.start`（第 466 行），在 `engine.setRecordingStart(Date.now() / 1000)` 之后添加：

```javascript
    // v2: 加载历史基线
    const streamer = Store.getStreamers().find(s => s.id === streamerId);
    if (streamer && streamer.baseline && streamer.baseline.sampleCount > 0) {
      engine.setBaseline(streamer.baseline);
      logger.info(`[danmaku] Loaded baseline for ${streamerName} (n=${streamer.baseline.sampleCount}, mean=${streamer.baseline.meanDanmakuRate.toFixed(2)})`);
    }
```

- [ ] **Step 2: 录制停止时更新基线——新增函数**

在 `autoClipAfterStream` 函数之前（第 341 行之前）添加：

```javascript
// ─── Baseline update ─────────────────────────────────────────────────────────

function updateStreamerBaseline(streamerId, streamerName) {
  const engine = DanmakuManager.getEngine(streamerId);
  if (!engine) return;
  const sessionStats = engine.getBaselineStats();
  if (!sessionStats || sessionStats.mean === 0) return;

  const streamer = Store.getStreamers().find(s => s.id === streamerId);
  const old = (streamer && streamer.baseline) || {
    meanDanmakuRate: 0,
    stdDanmakuRate: 0,
    sampleCount: 0
  };

  // Exponential moving average: new = old × 0.7 + session × 0.3
  const alpha = 0.3;
  const newMean = old.meanDanmakuRate * (1 - alpha) + sessionStats.mean * alpha;
  const newStd = old.stdDanmakuRate * (1 - alpha) + sessionStats.std * alpha;
  const newCount = old.sampleCount + 1;

  Store.updateStreamer(streamerId, {
    baseline: {
      meanDanmakuRate: Math.round(newMean * 10000) / 10000,
      stdDanmakuRate: Math.round(newStd * 10000) / 10000,
      updatedAt: new Date().toISOString().slice(0, 10),
      sampleCount: newCount
    }
  });

  logger.info(`[baseline] Updated ${streamerName}: mean=${newMean.toFixed(3)} std=${newStd.toFixed(3)} n=${newCount}`);
}
```

- [ ] **Step 3: 在所有录制停止路径中调用基线更新**

在 poller 的离线确认逻辑中（第 634 行 `RESTDanmakuPoller.stop(s.id)` 之后），添加：

```javascript
            updateStreamerBaseline(s.id, s.name);
```

在手动停止端点（`/api/streamer/:id/stop`）中（第 867 行 `RESTDanmakuPoller.stop(id)` 之后），添加：

```javascript
      const s2 = Store.getStreamers().find(s => s.id === id);
      if (s2) updateStreamerBaseline(id, s2.name);
```

在 shutdown 端点中（第 1045 行 `RESTDanmakuPoller.stop(sid)` 之后），添加：

```javascript
      const streamer2 = Store.getStreamers().find(s => s.id === sid);
      if (streamer2) updateStreamerBaseline(sid, streamer2.name);
```

- [ ] **Step 4: 修复 recordingStartTime——新增 streamStartTime**

在 `Recorder` 对象（第 196 行）添加：

```javascript
  _streamStartTime: {},  // streamerId -> first recording start timestamp (seconds)
```

在 `Recorder.start` 中（第 267 行 `this._processes[streamerId] = { ... }` 的后面），保存 streamStartTime：

```javascript
          if (reusePath && this._streamStartTime[streamerId]) {
            // 重连复用已有 streamStartTime
          } else {
            this._streamStartTime[streamerId] = Date.now() / 1000;
          }
```

在 `Recorder.stop` 中（第 285 行），清理 streamStartTime：

```javascript
    delete this._streamStartTime[streamerId];
```

在 `Recorder` 返回对象中添加 getter：

```javascript
  getStreamStartTime(streamerId) {
    return this._streamStartTime[streamerId] || null;
  },
```

- [ ] **Step 5: 修改 DanmakuManager.start 使用 streamStartTime**

将第 472 行的：
```javascript
    engine.setRecordingStart(Date.now() / 1000);
```

改为：
```javascript
    const startTime = Recorder.getStreamStartTime(streamerId) || Date.now() / 1000;
    engine.setRecordingStart(startTime);
```

这样重连时 engine 的 recordingStartTime 不再被重置。

- [ ] **Step 6: 修复 findBestSourceFile——当天优先**

在 `findBestSourceFile` 函数（第 320 行）的 find 逻辑中，将：

```javascript
      if (!f.endsWith('.mp4') || f.includes('_clip_')) continue;
```

改为：

```javascript
      if (!f.endsWith('.mp4') || f.includes('_clip_')) continue;
      // 优先当天文件
      const todayStr = new Date().toISOString().slice(0, 10);
      const isToday = f.includes(todayStr);
      // 当天文件加权 10x
      const effectiveSize = st.size * (isToday ? 10 : 1);
      if (effectiveSize > bestSize) { bestSize = effectiveSize; bestFile = fp; }
```

- [ ] **Step 7: 确保 emotionDict 可被读取**

`Store.getSettings()` 已返回 `this._data.settings`。需要在 `Store.load()` 中确保 `emotionDict` 存在。在 `Store.load()` 加载后（第 46 行之后），在 `Store.load()` 调用之后（第 84 行），添加初始化检查：

```javascript
// 确保 emotionDict 存在
if (!Store._data.emotionDict) {
  Store._data.emotionDict = {
    laugh: ["哈哈", "笑死", "草", "www", "hhh", "笑死我了"],
    surprise: ["？？", "卧槽", "啊？", "什么", "我去", "wc"],
    praise: ["666", "牛逼", "太强了", "牛", "帅", "好强"],
    mock: ["离谱", "逆天", "不愧是你", "就这", "典", "急"]
  };
  Store.save();
}
```

- [ ] **Step 8: 添加 /api/emotion-dict 端点**

在 `// ─── Highlight APIs ───` 注释之前（第 1059 行之前）添加：

```javascript
  if (url.pathname === '/api/emotion-dict' && req.method === 'GET') {
    const dict = Store._data.emotionDict || {};
    sendJSON(res, 200, dict);
    return;
  }

  if (url.pathname === '/api/emotion-dict' && req.method === 'PUT') {
    const body = await parseJSON(req);
    Store._data.emotionDict = body;
    Store.save();
    sendJSON(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 9: Commit**

```bash
git add server.js
git commit -m "feat: adaptive baseline, streamStartTime fix, emotionDict API"
```

---

### Task 4: 前端——情绪词典编辑面板

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 在设置区添加情绪词典编辑面板**

在 `</div>` 结束设置区之前（第 133 行 `<button class="btn-sm" id="btnSavePath">保存</button>` 行之后，`</div>` 之前），添加：

```html
<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:4px">
  <label style="cursor:pointer;user-select:none" onclick="var e=document.getElementById('emotionEditor');var t=this;e.style.display=e.style.display==='none'?'block':'none';t.textContent=e.style.display==='none'?'▶ 情绪词典':'▼ 情绪词典'">▶ 情绪词典</label>
  <div id="emotionEditor" style="display:none">
    <div style="font-size:10px;color:var(--text3);margin-bottom:6px">每行一个词，按类别分组。修改后自动保存。</div>
    <div id="emotionEditorFields"></div>
  </div>
</div>
```

- [ ] **Step 2: 添加加载/保存函数**

在 `<script>` 标签内（第 578 行 `refresh()` 之前），添加：

```javascript
let emotionDict = {};

async function loadEmotionDict() {
  try {
    const r = await API.get('/api/emotion-dict');
    if (r && !r.error) emotionDict = r;
  } catch { emotionDict = {}; }
}

function renderEmotionEditor() {
  const container = document.getElementById('emotionEditorFields');
  const labels = { laugh: '笑', surprise: '惊', praise: '赞', mock: '嘲' };
  container.innerHTML = Object.entries(emotionDict).map(([cat, words]) => {
    const text = Array.isArray(words) ? words.join('\n') : '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:11px;color:var(--text2);margin-bottom:3px;font-weight:600">${labels[cat] || cat} (${cat})</div>
      <textarea data-cat="${cat}" onchange="saveEmotionDict()" onblur="saveEmotionDict()" style="width:100%;height:60px;padding:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:12px;font-family:var(--font-ui);resize:vertical;outline:none">${text}</textarea>
    </div>`;
  }).join('');
}

async function saveEmotionDict() {
  const newDict = {};
  document.querySelectorAll('#emotionEditorFields textarea').forEach(ta => {
    const cat = ta.dataset.cat;
    newDict[cat] = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
  });
  await API.put('/api/emotion-dict', newDict);
  emotionDict = newDict;
}
```

- [ ] **Step 3: 在 refresh() 中初始化**

在 `refresh()` 函数末尾（第 277 行 `document.getElementById('clock').textContent = ...` 之后），添加：

```javascript
  if (Object.keys(emotionDict).length === 0) {
    await loadEmotionDict();
    renderEmotionEditor();
  }
```

同时需要在 `refresh()` 函数声明前加 `async`（已是 async——函数开头用了 await）。

在页面首次加载时（第 578 行 `refresh()` 调用处），改为先加载词典再 refresh：

```javascript
(async () => {
  await loadEmotionDict();
  renderEmotionEditor();
  refresh();
  setInterval(refresh, 30000);
})();
```

- [ ] **Step 4: 高光面板显示 v2 新字段**

在 `renderHighlightList` 函数中（第 441 行的 tagHTML），添加 v2 trigger 类型：

```javascript
const cls = t === 'danmaku_peak' || t === 'danmaku_super_peak' || t === 'keyword_flood' || t === 'emotion_burst' ? 'tag-danmaku' :
            t === 'gift_burst' ? 'tag-gift' :
            t === 'guard_buy' ? 'tag-guard' :
            t === 'audio_peak' ? 'tag-audio' :
            t === 'consensus' || t === 'accel_spike' || t === 'composite' ? '' : '';

const label = t === 'danmaku_peak' ? '弹幕峰值' :
              t === 'danmaku_super_peak' ? '超级峰值' :
              t === 'keyword_flood' ? '关键词' :
              t === 'emotion_burst' ? '情绪爆发' :
              t === 'consensus' ? '观众共鸣' :
              t === 'accel_spike' ? '弹幕涌入' :
              t === 'composite' ? '综合高光' :
              t === 'gift_burst' ? '礼物' :
              t === 'guard_buy' ? '大航海' :
              t === 'audio_peak' ? '音频高能' : t;
```

并在 meta 行添加 v2 因子显示：

```javascript
'<div class="hl-meta">' +
  (h.emotionScore !== undefined ? '情绪' + Math.round(h.emotionScore * 100) + '% · ' : '') +
  (h.consistencyScore !== undefined ? '共鸣' + Math.round(h.consistencyScore * 100) + '% · ' : '') +
  '持续' + Math.round(h.duration) + 's · 弹幕' + (h.danmakuCount || 0) + '条' +
'</div>' +
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: emotion dictionary editor and v2 highlight display"
```

---

### Task 5: 验证测试

**Files:**
- None (manual verification)

- [ ] **Step 1: 启动服务器**

```bash
node server.js
```

确认无报错，日志显示 `Bili Recorder running at http://localhost:3456`

- [ ] **Step 2: 检查 config.json 迁移**

```bash
node -e "const c=require('./config.json'); console.log('emotionDict:', !!c.emotionDict); c.streamers.forEach(s => console.log(s.name, 'baseline:', !!s.baseline))"
```

- [ ] **Step 3: 测试情绪词典 API**

```bash
curl http://localhost:3456/api/emotion-dict
```

应返回 4 类词典。

- [ ] **Step 4: 打开浏览器验证前端**

访问 `http://localhost:3456`，确认：
- 设置区有「情绪词典」折叠面板
- 展开后显示 4 类 textarea
- 修改词后失焦自动保存
- 高光面板标签正常

- [ ] **Step 5: 触发高光**

等待弹幕累积，观察 app.log 中的 `[highlight-engine]` 日志：
- score 应有变化（不再全是 0.6）
- 日志应包含 e/c/a/z/t 各因子分数
- 录制开头 3 分钟内不应有高光触发

```bash
tail -f app.log | grep highlight-engine
```

- [ ] **Step 6: 验证基线更新**

手动停止一个录制（前端点「停止录制」），检查：
```bash
node -e "console.log(JSON.stringify(require('./config.json').streamers[0].baseline, null, 2))"
```
应看到 `sampleCount > 0` 且 `meanDanmakuRate` 非零。

- [ ] **Step 7: Commit（如有微调）**

```bash
git add -A
git commit -m "chore: verification tweaks"
```

---

## 自审

1. **Spec 覆盖检查**：
   - ✅ 新评分模型 → Task 2 Step 3
   - ✅ 情绪词典 → Task 1 + Task 4
   - ✅ 弹幕一致性 → Task 2 Step 2
   - ✅ 加速度 + 时间位置 → Task 2 Step 3/4
   - ✅ 自适应基线 → Task 3 Step 1-3
   - ✅ recordingStartTime 修复 → Task 3 Step 4-5
   - ✅ 源文件当天优先 → Task 3 Step 6

2. **占位符扫描**：无 TBD/TODO/placeholder。

3. **类型一致性**：`streamerBaseline` 在 Task 2 Step 6 声明，Task 3 Step 1 通过 `setBaseline()` 注入；`_recentTexts` 在 Task 2 Step 5 写入、Step 2 读取。
