// highlight-engine.js — multi-signal fusion rule engine v3
// Consumes danmaku, gift, guard, audio, viewer-count events and fires highlight detections.
// v3 变更：
//   - 基线样本不足时 z 因子不参与（冷启动误报）
//   - 弹幕计数对单 uid 限幅（防刷屏灌水 z-score）
//   - cScore/aScore 提高绝对量下限（小房间/小爆发不再轻易满分）
//   - 情绪词典短词（≤2字）只在短弹幕中匹配（"草"不再命中"草莓"）
//   - 新增观众数涌入信号 feedViewerCount（+0.1 加权，不进权重和）
//   - tScore 移除（权重 0.05 无区分度），权重重新归一
//   - 关键词正则可在 config.json 配置（keywordPatterns），缺省用内置
//   - 高光窗口中心取最近 15s 内弹幕最多的那一秒，而不是过阈值的当下
//   - 音频峰 attach 比较峰值中心（修复原来拿 clip 起点比峰值永远差 300s 的死代码）

const { HighlightStore } = require('./highlight-store');
const { localDate } = require('./utils');

const WINDOW_S = 5;
const BASELINE_S = 60;
const MIN_HIGHLIGHT_INTERVAL_S = 600;  // 10min — avoid overlapping clips
const CLIP_BEFORE_S = 300;  // 5min before peak
const CLIP_AFTER_S = 300;   // 5min after peak

// v2 constants
const MIN_DANMAKU_5S = 3;       // absolute floor: <3 danmaku in 5s → no trigger
const COOLDOWN_S = 180;         // first 3min of recording: hard filter
const SCORE_THRESHOLD = 0.3;    // minimum score to trigger

// v3 constants
const MIN_BASELINE_SAMPLES = 30;  // 基线样本少于此数时 z 因子不参与
const UID_CAP_PER_SEC = 3;        // 单 uid 每秒最多计入 3 条（防刷屏）
const VIEWER_SURGE_RATIO = 0.5;   // 60s 内观众数涨 50% → viewerScore 1.0
const PEAK_CENTER_LOOKBACK_S = 15;

// 权重（和 = 1.0）
const W_EMOTION = 0.37;
const W_CONSISTENCY = 0.32;
const W_ACCELERATION = 0.16;
const W_ZSCORE = 0.15;

const DEFAULT_KEYWORD_PATTERNS = [
  /^？{2,}/,
  /^6{2,}/,
  /^(牛[逼批bB]+|n[iI]+[cC]+[eE]+)/,
  /^(卧槽|我操|wc|Wc|WC)/,
  /^(名场面|合影|录屏|保存|截图|高能|前方高能)/,
  /^(啊|什么|离谱|逆天|不愧是你)/,
  /^(来了来了|恭喜|起飞|拿下|有了)/
];

function matchKeyword(text, patterns) {
  const trimmed = text.trim();
  for (const re of patterns) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// ─── Emotion matching ─────────────────────────────────────────────────────────

function matchEmotionCategories(text, emotionDict) {
  if (!emotionDict) return [];
  const trimmed = text.trim();
  const hits = [];
  for (const [category, patterns] of Object.entries(emotionDict)) {
    for (const p of patterns) {
      // 短词（≤2 字）只在短弹幕中匹配，避免 "草" 命中 "草莓"、"牛" 命中 "牛奶"
      const isHit = p.length <= 2
        ? (trimmed.length <= p.length + 2 && trimmed.includes(p))
        : trimmed.includes(p);
      if (isHit) { hits.push(category); break; }
    }
  }
  return hits;
}

// danmakuList: [{text, uid}] within current 5s window
function emotionScore(danmakuList, emotionDict) {
  if (!danmakuList || danmakuList.length === 0) return 0;
  const total = danmakuList.length;
  const deduped = new Map(); // uid:text -> true, same uid same text counts once
  let emotionHits = 0;

  for (const d of danmakuList) {
    const key = d.uid + ':' + d.text;
    if (deduped.has(key)) continue;
    deduped.set(key, true);
    const hits = matchEmotionCategories(d.text, emotionDict);
    if (hits.length > 0) emotionHits++;
  }
  return Math.min(1, (emotionHits / total) * 3);
}

// ─── Consistency detection ──────────────────────────────────────────────────────

// Group by text content, find largest group of different users saying same thing
function consistencyScore(danmakuList) {
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

  // 绝对量下限：少于 3 个不同用户说同一段话不算共识
  if (maxSize < 3) return 0;
  const activeUsers = new Set(danmakuList.map(d => d.uid)).size;
  // 分母下限 10：小房间不再轻易拿高分
  return maxSize / Math.max(10, activeUsers);
}

// ─── Baseline statistics ────────────────────────────────────────────────────────

function baselineStats(buckets, field, nowSec, baselineSec) {
  const fromSec = nowSec - baselineSec * 2;
  const toSec = nowSec - baselineSec;
  const values = [];
  for (const b of buckets) {
    if (b.idx >= fromSec && b.idx < toSec) {
      values.push(b[field]);
    }
  }
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0.1, n: 0 };

  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;

  let sumSq = 0;
  for (const v of values) sumSq += (v - mean) * (v - mean);
  const std = Math.max(0.1, Math.sqrt(sumSq / n));

  return { mean, std, n };
}

// ─── Window sum ─────────────────────────────────────────────────────────────────

function windowSum(buckets, field, windowEnd, windowSec) {
  const fromSec = windowEnd - windowSec;
  let total = 0;
  for (const b of buckets) {
    if (b.idx > fromSec && b.idx <= windowEnd) {
      total += b[field];
    }
  }
  return total;
}

// ─── Bucket get-or-create (feedDanmaku / feedGift 共用) ─────────────────────────

function touchBucket(buckets, idx, fields) {
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (buckets[i].idx === idx) return buckets[i];
    if (buckets[i].idx < idx) {
      const bucket = { idx, ...fields };
      buckets.splice(i + 1, 0, bucket);
      return bucket;
    }
  }
  const bucket = { idx, ...fields };
  buckets.unshift(bucket);
  return bucket;
}

// 编译关键词正则（config 里是字符串）；坏正则跳过
function compilePatterns(list) {
  const out = [];
  for (const s of list || []) {
    try { out.push(s instanceof RegExp ? s : new RegExp(s)); } catch {}
  }
  return out;
}

// ─── Factory ────────────────────────────────────────────────────────────────────

function createHighlightEngine(streamerId, streamerName, roomId, logger, emotionDict, keywordPatterns) {
  const danmakuBuckets = [];
  const giftBuckets = [];
  let recordingStartTime = null;
  let lastHighlightTime = 0;
  let streamerBaseline = null;
  let _recentTexts = [];     // [{text, uid, ts}] 按时间升序，供情绪/一致性分析
  let _recentStart = 0;      // 滑动修剪指针（避免每次 filter 的 O(n) 重分配）
  let _viewerSamples = [];   // [{ts, count}] 最近 120s 观众数采样
  let _uidSecIdx = -1;       // 当前秒的 uid 计数（刷屏限幅）
  let _uidSecMap = new Map();

  const compiledKeywords = keywordPatterns
    ? compilePatterns(keywordPatterns)
    : DEFAULT_KEYWORD_PATTERNS;

  function nowSec() {
    return Date.now() / 1000;
  }

  function today() {
    return localDate();
  }

  function pruneBuckets(buckets, cutoff) {
    let removeCount = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].idx >= cutoff) break;
      removeCount++;
    }
    if (removeCount > 0) buckets.splice(0, removeCount);
  }

  // ─── 辅助：观众数涌入分数（60s 窗口内从最低点上涨的幅度） ─────────────────────

  function viewerScore(now) {
    const recent = _viewerSamples.filter(s => s.ts >= now - 60);
    if (recent.length < 2) return 0;
    let min = Infinity;
    for (const s of recent) if (s.count < min) min = s.count;
    const cur = recent[recent.length - 1].count;
    if (min <= 0) return 0;
    return Math.min(1, Math.max(0, (cur - min) / (min * VIEWER_SURGE_RATIO)));
  }

  // ─── 辅助：最近 15s 内弹幕最多的那一秒作为高光中心 ────────────────────────────

  function recentPeakSecond(now) {
    let bestIdx = Math.floor(now);
    let bestCount = -1;
    for (const b of danmakuBuckets) {
      if (b.idx < now - PEAK_CENTER_LOOKBACK_S || b.idx > now) continue;
      if (b.count > bestCount) { bestCount = b.count; bestIdx = b.idx; }
    }
    return bestIdx + 0.5;
  }

  function determineTriggers(eScore, cScore, aScore, zScore, vScore) {
    const triggers = [];
    if (eScore >= 0.5) triggers.push('emotion_burst');
    if (cScore >= 0.5) triggers.push('consensus');
    if (aScore >= 0.5) triggers.push('accel_spike');
    if (zScore >= 0.5) triggers.push('danmaku_peak');
    if (vScore >= 0.5) triggers.push('viewer_surge');
    if (triggers.length === 0) triggers.push('composite');
    return triggers;
  }

  function makeTitle(triggers) {
    if (triggers.includes('emotion_burst') && triggers.includes('consensus'))
      return '情绪共鸣';
    if (triggers.includes('emotion_burst')) return '弹幕情绪爆发';
    if (triggers.includes('consensus')) return '观众一致反应';
    if (triggers.includes('accel_spike')) return '弹幕涌入';
    if (triggers.includes('viewer_surge')) return '观众涌入';
    if (triggers.includes('danmaku_peak')) return '弹幕高峰';
    return '综合高光';
  }

  // ─── Feed functions ─────────────────────────────────────────────────────────

  function feedDanmaku(text, uid) {
    const now = nowSec();
    const idx = Math.floor(now);

    const bucket = touchBucket(danmakuBuckets, idx, { count: 0, keywordCount: 0 });

    // 单 uid 每秒限幅：刷屏不再灌水 z-score / 加速度
    // uid 为 0/未知（REST gethistory 无 uid）时跳过限幅——REST 是主力弹幕通道，
    // 批量到达的消息会被误判成"同一用户刷屏"
    if (idx !== _uidSecIdx) { _uidSecIdx = idx; _uidSecMap = new Map(); }
    let capped = false;
    if (uid) {
      const uidCount = _uidSecMap.get(uid) || 0;
      _uidSecMap.set(uid, uidCount + 1);
      capped = uidCount >= UID_CAP_PER_SEC;
    }

    if (!capped) {
      bucket.count++;
      if (matchKeyword(text, compiledKeywords)) bucket.keywordCount++;
    }

    const cutoff = Math.floor(now - BASELINE_S * 2);
    pruneBuckets(danmakuBuckets, cutoff);

    // 弹幕原文保留 60s，供情绪/一致性分析（情绪分自己做去重，不受限幅影响）
    _recentTexts.push({ text, uid: uid || 0, ts: now });
    const textCutoff = now - 60;
    while (_recentStart < _recentTexts.length && _recentTexts[_recentStart].ts <= textCutoff) _recentStart++;
    if (_recentStart > 5000) { _recentTexts = _recentTexts.slice(_recentStart); _recentStart = 0; }
    // 极端大房间的保险丝：最多保留最近 20 万条
    if (_recentTexts.length - _recentStart > 200000) {
      _recentTexts = _recentTexts.slice(-60000);
      _recentStart = 0;
    }

    evaluate(now);
  }

  function feedGift(rmb) {
    const now = nowSec();
    const idx = Math.floor(now);

    const bucket = touchBucket(giftBuckets, idx, { valueRmb: 0 });
    bucket.valueRmb += rmb;

    const cutoff = Math.floor(now - BASELINE_S * 2);
    pruneBuckets(giftBuckets, cutoff);

    evaluate(now);
  }

  function feedGuard(guardLevel, guardName, rmb) {
    // Only trigger standalone for levels 1 (总督) and 2 (提督)
    if (guardLevel <= 2) {
      if (!recordingStartTime) return;

      const now = nowSec();
      if (now - lastHighlightTime < MIN_HIGHLIGHT_INTERVAL_S) return;
      const startOffset = Math.max(0, now - recordingStartTime - CLIP_BEFORE_S);
      const endOffset = now - recordingStartTime + CLIP_AFTER_S;

      const highlight = {
        startOffset: Math.round(startOffset * 100) / 100,
        endOffset: Math.round(endOffset * 100) / 100,
        duration: CLIP_BEFORE_S + CLIP_AFTER_S,
        score: Math.round(Math.min(1, rmb / 20000) * 100) / 100,
        triggers: ['guard_buy'],
        danmakuCount: 0,
        peakDanmakuRate: 0,
        totalGiftValue: Math.round(rmb * 100) / 100,
        audioPeakDb: null,
        peakTs: now,
        title: guardName + '开通！'
      };

      HighlightStore.add(streamerName, today(), highlight);
      lastHighlightTime = now;
      logger.info('[highlight-engine] Rule 4 guard_buy: ' + guardName + ' ¥' + rmb);
    }

    // Level 3 (舰长) — feed to gift buckets for accumulation
    if (guardLevel === 3) {
      feedGift(rmb);
    }
  }

  // 观众数采样（由 Poller 每 30s 喂一次）。只记录不触发，评分在 evaluate 里读取
  function feedViewerCount(count) {
    if (!count || count <= 0) return;
    const now = nowSec();
    _viewerSamples.push({ ts: now, count });
    const cutoff = now - 120;
    _viewerSamples = _viewerSamples.filter(s => s.ts > cutoff);
  }

  // ─── Core evaluation (v3 multi-factor) ──────────────────────────────────────

  function evaluate(now) {
    if (!recordingStartTime) return;
    if (now - lastHighlightTime < MIN_HIGHLIGHT_INTERVAL_S) return;

    const offset = now - recordingStartTime;

    // Hard filter: cooldown period
    if (offset < COOLDOWN_S) return;

    // Absolute floor
    const danmaku5s = windowSum(danmakuBuckets, 'count', now, WINDOW_S);
    if (danmaku5s < MIN_DANMAKU_5S) return;

    // Recent danmaku for emotion/consistency（从尾部向前取 5s 窗口，O(窗口) 而非 O(全部)）
    const recentDanmaku = [];
    for (let i = _recentTexts.length - 1; i >= _recentStart; i--) {
      const d = _recentTexts[i];
      if (d.ts < now - WINDOW_S) break;
      recentDanmaku.push(d);
    }
    recentDanmaku.reverse();

    // ── Factor scores ──

    const eScore = emotionScore(recentDanmaku, emotionDict);

    const cScore = consistencyScore(recentDanmaku);

    const prevDanmaku5s = windowSum(danmakuBuckets, 'count', now - WINDOW_S, WINDOW_S);
    const accel = danmaku5s - prevDanmaku5s;
    // 除数下限 8：0→4 条的小爆发不再拿满分
    const aScore = Math.min(1, Math.max(0, accel / Math.max(8, prevDanmaku5s * 2)));

    // 基线样本不足（开播初期）时 z 因子不参与，避免虚高误报
    const baseline = streamerBaseline || baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    let zScore = 0;
    if (streamerBaseline || baseline.n >= MIN_BASELINE_SAMPLES) {
      const danmakuRate = danmaku5s / WINDOW_S;
      const dZ = baseline.std > 0 ? (danmakuRate - baseline.mean) / baseline.std : 0;
      zScore = Math.min(1, dZ / 8);
    }

    // 观众数涌入（加权 +0.1，不进权重和）
    const vScore = viewerScore(now);

    // ── Fused score ──
    const fused = eScore * W_EMOTION +
      cScore * W_CONSISTENCY +
      aScore * W_ACCELERATION +
      zScore * W_ZSCORE;
    const score = Math.round(Math.min(1, fused + vScore * 0.1) * 100) / 100;

    if (score < SCORE_THRESHOLD) return;

    // ── Determine triggers ──
    const triggers = determineTriggers(eScore, cScore, aScore, zScore, vScore);

    // Gift check (lowered threshold ¥50)
    const gift10sRmb = windowSum(giftBuckets, 'valueRmb', now, 10);
    if (gift10sRmb > 50 && !triggers.includes('gift_burst')) {
      triggers.push('gift_burst');
    }

    // Keyword check (lowered threshold 5)
    const keyword5s = windowSum(danmakuBuckets, 'keywordCount', now, WINDOW_S);
    if (keyword5s >= 5) {
      if (!triggers.includes('keyword_flood')) triggers.push('keyword_flood');
    }

    const title = makeTitle(triggers);

    // ── Build highlight（窗口中心取最近 15s 弹幕最多的那一秒） ──
    const center = recentPeakSecond(now);
    const snapshot = recentDanmaku.map(d => d.text);
    const highlight = createHighlight(center, triggers, danmaku5s, gift10sRmb, null, snapshot);
    highlight.score = score;
    highlight.title = title;
    highlight.emotionScore = Math.round(eScore * 100) / 100;
    highlight.consistencyScore = Math.round(cScore * 100) / 100;
    highlight.accelScore = Math.round(aScore * 100) / 100;
    highlight.viewerScore = Math.round(vScore * 100) / 100;

    commitHighlight(now, highlight, 'v3 score=' + score.toFixed(2) +
      ' (e=' + eScore.toFixed(2) + ' c=' + cScore.toFixed(2) +
      ' a=' + aScore.toFixed(2) + ' z=' + zScore.toFixed(2) +
      ' v=' + vScore.toFixed(2) + ') ' + title);
  }

  function createHighlight(center, triggers, danmaku5s, gift10sRmb, audioPeakDb, danmakuSnapshot) {
    const startOffset = Math.max(0, center - recordingStartTime - CLIP_BEFORE_S);
    const endOffset = center - recordingStartTime + CLIP_AFTER_S;
    return {
      startOffset: Math.round(startOffset * 100) / 100,
      endOffset: Math.round(endOffset * 100) / 100,
      duration: CLIP_BEFORE_S + CLIP_AFTER_S,
      score: 0,
      triggers: triggers,
      danmakuCount: danmaku5s,
      peakDanmakuRate: Math.round((danmaku5s / WINDOW_S) * 100) / 100,
      totalGiftValue: Math.round(gift10sRmb * 100) / 100,
      audioPeakDb: audioPeakDb,
      peakTs: center,  // 墙钟时间（秒），切片时经 segments.json 映射到正确的分片文件
      title: '',
      danmakuSnapshot: danmakuSnapshot || []
    };
  }

  function commitHighlight(now, highlight, logMsg) {
    HighlightStore.add(streamerName, today(), highlight);
    lastHighlightTime = now;
    logger.info('[highlight-engine] ' + logMsg);
  }

  // sourceFile：音频分析对应的录像分片。音频高光的偏移是该文件内的偏移，直接按源文件切。
  // segStartTs：该分片的起始墙钟秒（来自 segments.json），用于把音频峰换算成墙钟时间与
  // 弹幕高光比较；缺省时退回"同一录制会话"的近似比较。
  function feedAudioResult(audioPeaks, sourceFile, segStartTs) {
    if (!recordingStartTime) return;

    const date = today();
    const data = HighlightStore.getAll(streamerName, date);
    const existing = (data && data.highlights) ? data.highlights : [];

    for (const peak of audioPeaks) {
      const peakOffset = peak.startOffset;
      // 音频峰的统一时间基准：优先墙钟（跨分片安全），退回流内偏移
      const peakRef = (segStartTs != null) ? segStartTs + peakOffset : null;
      let matched = false;

      // Attach to an existing highlight whose peak center is within 60s
      for (let i = existing.length - 1; i >= 0; i--) {
        const h = existing[i];
        // 高光峰值中心（旧数据无 peakTs 时用 startOffset + CLIP_BEFORE_S 近似）
        const hCenter = (peakRef != null && h.peakTs != null)
          ? h.peakTs
          : h.startOffset + CLIP_BEFORE_S;
        const compareTo = (peakRef != null && h.peakTs != null) ? peakRef : peakOffset;
        if (Math.abs(hCenter - compareTo) < 60) {
          const newAudioDb = (h.audioPeakDb == null || peak.maxDb > h.audioPeakDb)
            ? Math.round(peak.maxDb * 100) / 100
            : h.audioPeakDb;
          const newTriggers = h.triggers.includes('audio_peak')
            ? h.triggers
            : [...h.triggers, 'audio_peak'];
          const newScore = Math.round(Math.min(1, h.score + 0.1) * 100) / 100;

          HighlightStore.update(streamerName, date, h.id, {
            audioPeakDb: newAudioDb,
            triggers: newTriggers,
            score: newScore
          });

          h.audioPeakDb = newAudioDb;
          h.triggers = newTriggers;
          h.score = newScore;

          matched = true;
          logger.info('[highlight-engine] Rule 5 audio_peak attached to ' + h.id + ' (db=' + peak.maxDb.toFixed(1) + ')');
          break;
        }
      }

      // Create new audio-only highlight if no nearby and volume is significant
      if (!matched && peak.maxDb > -12) {
        const startOffset = Math.max(0, Math.round((peak.startOffset - CLIP_BEFORE_S) * 100) / 100);
        const endOffset = Math.round((peak.endOffset + CLIP_AFTER_S) * 100) / 100;
        const highlight = {
          startOffset: startOffset,
          endOffset: endOffset,
          duration: CLIP_BEFORE_S + CLIP_AFTER_S,
          score: 0.3,
          triggers: ['audio_peak'],
          danmakuCount: 0,
          peakDanmakuRate: 0,
          totalGiftValue: 0,
          audioPeakDb: Math.round(peak.maxDb * 100) / 100,
          title: '音频高峰'
        };
        // 音频高光的偏移是 sourceFile 文件内的偏移（与流起点无关），切片直接用它
        if (sourceFile) highlight.sourceFile = sourceFile;
        if (peakRef != null) highlight.peakTs = peakRef;
        HighlightStore.add(streamerName, date, highlight);
        logger.info('[highlight-engine] Rule 5 audio_peak new (db=' + peak.maxDb.toFixed(1) + ')');
      }
    }
  }

  function getStats() {
    const now = nowSec();
    const danmaku5s = windowSum(danmakuBuckets, 'count', now, WINDOW_S);
    const danmaku60s = windowSum(danmakuBuckets, 'count', now, 60);
    const gift10s = windowSum(giftBuckets, 'valueRmb', now, 10);
    const gift60s = windowSum(giftBuckets, 'valueRmb', now, 60);
    const keyword5s = windowSum(danmakuBuckets, 'keywordCount', now, WINDOW_S);
    const keywordRatio = danmaku5s > 0 ? keyword5s / danmaku5s : 0;
    const baseline = streamerBaseline || baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    const danmakuRate = danmaku60s / 60;
    const dZ = (streamerBaseline || baseline.n >= MIN_BASELINE_SAMPLES) && baseline.std > 0
      ? (danmakuRate - baseline.mean) / baseline.std
      : 0;
    const latestViewer = _viewerSamples.length > 0 ? _viewerSamples[_viewerSamples.length - 1].count : null;

    return {
      danmakuRate,
      danmakuZ: Math.round(dZ * 100) / 100,
      danmaku5s,
      danmaku60s,
      keyword5s,
      keywordRatio: Math.round(keywordRatio * 100) / 100,
      gift10s: Math.round(gift10s * 100) / 100,
      gift60s: Math.round(gift60s * 100) / 100,
      viewerCount: latestViewer,
      viewerScore: Math.round(viewerScore(now) * 100) / 100,
      lastHighlightTime: lastHighlightTime > 0 ? lastHighlightTime : null
    };
  }

  return {
    setRecordingStart: function (ts) {
      recordingStartTime = ts;
      lastHighlightTime = 0;
      danmakuBuckets.length = 0;
      giftBuckets.length = 0;
      _recentTexts = [];
      _recentStart = 0;
      _viewerSamples = [];
      _uidSecIdx = -1;
      _uidSecMap = new Map();
    },
    setBaseline: function (baseline) {
      streamerBaseline = baseline;
    },
    getBaselineStats: function () {
      const now = nowSec();
      return baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    },
    feedDanmaku,
    feedGift,
    feedGuard,
    feedViewerCount,
    feedAudioResult,
    getStats
  };
}

module.exports = { createHighlightEngine };
