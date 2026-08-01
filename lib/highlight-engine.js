// highlight-engine.js — multi-signal fusion rule engine v2
// Consumes danmaku, gift, guard, audio events and fires highlight detections.
// v2: emotion density + consistency + acceleration + time-position multi-factor scoring

const { HighlightStore } = require('./highlight-store');
const { localDate } = require('./utils');

const WINDOW_S = 5;
const BASELINE_S = 60;
const SIGMA_DANMAKU_3 = 3.0;
const SIGMA_DANMAKU_5 = 5.0;
const GIFT_THRESHOLD_RMB = 100;
const MIN_HIGHLIGHT_INTERVAL_S = 600;  // 10min — avoid overlapping clips
const CLIP_BEFORE_S = 300;  // 5min before peak
const CLIP_AFTER_S = 300;   // 5min after peak

// v2 constants
const MIN_DANMAKU_5S = 3;       // absolute floor: <3 danmaku in 5s → no trigger
const COOLDOWN_S = 180;         // first 3min of recording: hard filter
const SCORE_THRESHOLD = 0.3;    // minimum score to trigger
const W_EMOTION = 0.35;
const W_CONSISTENCY = 0.30;
const W_ACCELERATION = 0.15;
const W_ZSCORE = 0.15;
const W_TIME = 0.05;

const KEYWORD_PATTERNS = [
  /^\？{2,}/,
  /^6{2,}/,
  /^(牛[逼批bB]+|n[iI]+[cC]+[eE]+)/,
  /^(卧槽|我操|wc|Wc|WC)/,
  /^(名场面|合影|录屏|保存|截图|高能|前方高能)/,
  /^(啊|什么|离谱|逆天|不愧是你)/,
  /^(来了来了|恭喜|起飞|拿下|有了)/
];

function matchKeyword(text) {
  const trimmed = text.trim();
  for (const re of KEYWORD_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// ─── v2: Emotion matching ──────────────────────────────────────────────────────

function matchEmotionCategories(text, emotionDict) {
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

// ─── v2: Consistency detection ──────────────────────────────────────────────────

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

  const activeUsers = new Set(danmakuList.map(d => d.uid)).size;
  return maxSize / Math.max(5, activeUsers);
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
  if (n === 0) return { mean: 0, std: 0.1 };

  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;

  let sumSq = 0;
  for (const v of values) sumSq += (v - mean) * (v - mean);
  const std = Math.max(0.1, Math.sqrt(sumSq / n));

  return { mean, std };
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

// ─── Factory ────────────────────────────────────────────────────────────────────

function createHighlightEngine(streamerId, streamerName, roomId, logger, emotionDict) {
  const danmakuBuckets = [];
  const giftBuckets = [];
  let recordingStartTime = null;
  let lastHighlightTime = 0;
  let streamerBaseline = null;
  let _recentTexts = [];  // [{text, uid, ts}] for emotion/consistency analysis

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

  // ─── v2 helpers ─────────────────────────────────────────────────────────────

  function timePositionScore(offset) {
    if (offset < COOLDOWN_S) return 0;
    if (offset < 300) return 0.5;
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

  // ─── Feed functions ─────────────────────────────────────────────────────────

  function feedDanmaku(text, uid) {
    const now = nowSec();
    const idx = Math.floor(now);

    const bucket = touchBucket(danmakuBuckets, idx, { count: 0, keywordCount: 0 });
    bucket.count++;
    if (matchKeyword(text)) bucket.keywordCount++;

    const cutoff = Math.floor(now - BASELINE_S * 2);
    pruneBuckets(danmakuBuckets, cutoff);

    // v2: store recent texts for emotion and consistency analysis
    _recentTexts.push({ text, uid: uid || 0, ts: now });
    const textCutoff = now - 60;
    _recentTexts = _recentTexts.filter(d => d.ts > textCutoff);

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

  function feedViewerCount(count) {
    // Viewer count is tracked but does not trigger rules directly.
  }

  // ─── Core evaluation (v2 multi-factor) ──────────────────────────────────────

  function evaluate(now) {
    if (!recordingStartTime) return;
    if (now - lastHighlightTime < MIN_HIGHLIGHT_INTERVAL_S) return;

    const offset = now - recordingStartTime;

    // Hard filter: cooldown period
    if (offset < COOLDOWN_S) return;

    // Absolute floor
    const danmaku5s = windowSum(danmakuBuckets, 'count', now, WINDOW_S);
    if (danmaku5s < MIN_DANMAKU_5S) return;

    // Recent danmaku for emotion/consistency
    const recentDanmaku = _recentTexts.filter(d => d.ts >= now - WINDOW_S && d.ts <= now);

    // ── Factor scores ──

    const eScore = emotionScore(recentDanmaku, emotionDict);

    const cScore = consistencyScore(recentDanmaku);

    const prevDanmaku5s = windowSum(danmakuBuckets, 'count', now - WINDOW_S, WINDOW_S);
    const accel = danmaku5s - prevDanmaku5s;
    const aScore = Math.min(1, Math.max(0, accel / Math.max(4, prevDanmaku5s * 2)));

    const baseline = streamerBaseline || baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    const danmakuRate = danmaku5s / WINDOW_S;
    const dZ = baseline.std > 0 ? (danmakuRate - baseline.mean) / baseline.std : 0;
    const zScore = Math.min(1, dZ / 8);

    const tScore = timePositionScore(offset);

    // ── Fused score ──
    const score = Math.round(
      (eScore * W_EMOTION +
       cScore * W_CONSISTENCY +
       aScore * W_ACCELERATION +
       zScore * W_ZSCORE +
       tScore * W_TIME) * 100
    ) / 100;

    if (score < SCORE_THRESHOLD) return;

    // ── Determine triggers ──
    const triggers = determineTriggers(eScore, cScore, aScore, zScore);

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

    const title = makeTitle(triggers, eScore, cScore);

    // ── Build highlight ──
    const snapshot = recentDanmaku.map(d => d.text);
    const highlight = createHighlight(now, triggers, danmaku5s, gift10sRmb, null, snapshot);
    highlight.score = score;
    highlight.title = title;
    highlight.emotionScore = Math.round(eScore * 100) / 100;
    highlight.consistencyScore = Math.round(cScore * 100) / 100;
    highlight.accelScore = Math.round(aScore * 100) / 100;

    commitHighlight(now, highlight, 'v2 score=' + score.toFixed(2) +
      ' (e=' + eScore.toFixed(2) + ' c=' + cScore.toFixed(2) +
      ' a=' + aScore.toFixed(2) + ' z=' + zScore.toFixed(2) +
      ' t=' + tScore.toFixed(2) + ') ' + title);
  }

  function createHighlight(now, triggers, danmaku5s, gift10sRmb, audioPeakDb, danmakuSnapshot) {
    const startOffset = Math.max(0, now - recordingStartTime - CLIP_BEFORE_S);
    const endOffset = now - recordingStartTime + CLIP_AFTER_S;
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
      title: '',
      danmakuSnapshot: danmakuSnapshot || []
    };
  }

  function commitHighlight(now, highlight, logMsg) {
    HighlightStore.add(streamerName, today(), highlight);
    lastHighlightTime = now;
    logger.info('[highlight-engine] ' + logMsg);
  }

  function feedAudioResult(audioPeaks) {
    if (!recordingStartTime) return;

    const date = today();
    const data = HighlightStore.getAll(streamerName, date);
    const existing = (data && data.highlights) ? data.highlights : [];

    for (const peak of audioPeaks) {
      const peakOffset = peak.startOffset;
      let matched = false;

      // Check if any existing highlight is within 15s
      for (let i = existing.length - 1; i >= 0; i--) {
        const h = existing[i];
        if (Math.abs(h.startOffset - peakOffset) < 60) {
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
    const dZ = baseline.std > 0 ? (danmakuRate - baseline.mean) / baseline.std : 0;

    return {
      danmakuRate,
      danmakuZ: Math.round(dZ * 100) / 100,
      danmaku5s,
      danmaku60s,
      keyword5s,
      keywordRatio: Math.round(keywordRatio * 100) / 100,
      gift10s: Math.round(gift10s * 100) / 100,
      gift60s: Math.round(gift60s * 100) / 100,
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
