// highlight-engine.js — multi-signal fusion rule engine
// Consumes danmaku, gift, guard, audio events and fires highlight detections.

const { HighlightStore } = require('./highlight-store');

const WINDOW_S = 5;
const BASELINE_S = 60;
const SIGMA_DANMAKU_3 = 3.0;
const SIGMA_DANMAKU_5 = 5.0;
const GIFT_THRESHOLD_RMB = 100;
const MIN_HIGHLIGHT_INTERVAL_S = 30;

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

// ─── Factory ────────────────────────────────────────────────────────────────────

function createHighlightEngine(streamerId, streamerName, roomId, logger) {
  const danmakuBuckets = [];
  const giftBuckets = [];
  let recordingStartTime = null;
  let lastHighlightTime = 0;

  function nowSec() {
    return Date.now() / 1000;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function pruneBuckets(buckets, cutoff) {
    let removeCount = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].idx >= cutoff) break;
      removeCount++;
    }
    if (removeCount > 0) buckets.splice(0, removeCount);
  }

  function feedDanmaku(text) {
    const now = nowSec();
    const idx = Math.floor(now);

    let bucket = null;
    for (let i = danmakuBuckets.length - 1; i >= 0; i--) {
      if (danmakuBuckets[i].idx === idx) { bucket = danmakuBuckets[i]; break; }
      if (danmakuBuckets[i].idx < idx) {
        bucket = { idx, count: 0, keywordCount: 0 };
        danmakuBuckets.splice(i + 1, 0, bucket);
        break;
      }
    }
    if (!bucket) {
      bucket = { idx, count: 0, keywordCount: 0 };
      danmakuBuckets.unshift(bucket);
    }

    bucket.count++;
    if (matchKeyword(text)) bucket.keywordCount++;

    const cutoff = Math.floor(now - BASELINE_S * 2);
    pruneBuckets(danmakuBuckets, cutoff);

    evaluate(now);
  }

  function feedGift(rmb) {
    const now = nowSec();
    const idx = Math.floor(now);

    let bucket = null;
    for (let i = giftBuckets.length - 1; i >= 0; i--) {
      if (giftBuckets[i].idx === idx) { bucket = giftBuckets[i]; break; }
      if (giftBuckets[i].idx < idx) {
        bucket = { idx, valueRmb: 0 };
        giftBuckets.splice(i + 1, 0, bucket);
        break;
      }
    }
    if (!bucket) {
      bucket = { idx, valueRmb: 0 };
      giftBuckets.unshift(bucket);
    }

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
      const startOffset = Math.max(0, now - recordingStartTime - 3);
      const endOffset = now - recordingStartTime + 3;

      const highlight = {
        startOffset: Math.round(startOffset * 100) / 100,
        endOffset: Math.round(endOffset * 100) / 100,
        duration: 6,
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
    // Future use: anomaly detection on viewer spikes.
  }

  function evaluate(now) {
    if (!recordingStartTime) return;
    if (now - lastHighlightTime < MIN_HIGHLIGHT_INTERVAL_S) return;

    // ── Danmaku stats ──
    const danmaku5s = windowSum(danmakuBuckets, 'count', now, WINDOW_S);
    const baseline = baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
    // Z-score: compare per-second rate against baseline per-second rate
    const danmakuRate = danmaku5s / WINDOW_S;
    const baselineRate = baseline.mean;
    const dZ = baseline.std > 0 ? (danmakuRate - baselineRate) / baseline.std : 0;

    // ── Gift stats ──
    const gift10sRmb = windowSum(giftBuckets, 'valueRmb', now, 10);
    const giftScore = Math.min(1, gift10sRmb / 200);

    // ── Keyword stats ──
    const keyword5s = windowSum(danmakuBuckets, 'keywordCount', now, WINDOW_S);
    const keywordRatio = danmaku5s > 0 ? keyword5s / danmaku5s : 0;
    const keywordScore = Math.min(1, keyword5s / 20);

    const dScore = Math.min(1, dZ / 6);

    // ── Rule 3: Super Peak (>5σ) ──
    if (dZ > SIGMA_DANMAKU_5) {
      const highlight = createHighlight(now, ['danmaku_super_peak'], danmaku5s, gift10sRmb, null);
      highlight.score = Math.round(Math.min(1, dZ / 10) * 100) / 100;
      highlight.title = '弹幕超级高峰';
      commitHighlight(now, highlight, 'Rule 3 super_peak (z=' + dZ.toFixed(2) + ')');
      return;
    }

    // ── Rule 1: Danmaku + Gift ──
    if (dZ > SIGMA_DANMAKU_3 && gift10sRmb > GIFT_THRESHOLD_RMB) {
      const score = dScore * 0.5 + giftScore * 0.5;
      const highlight = createHighlight(now, ['danmaku_peak', 'gift_burst'], danmaku5s, gift10sRmb, null);
      highlight.score = Math.round(score * 100) / 100;
      highlight.title = '弹幕+礼物双爆发';
      commitHighlight(now, highlight, 'Rule 1 danmaku_peak+gift_burst (z=' + dZ.toFixed(2) + ' gift=' + gift10sRmb.toFixed(1) + ')');
      return;
    }

    // ── Rule 2: Danmaku + Keyword ──
    if (dZ > SIGMA_DANMAKU_3 && (keyword5s > 10 || keywordRatio > 0.3)) {
      const score = dScore * 0.5 + keywordScore * 0.5;
      const highlight = createHighlight(now, ['danmaku_peak', 'keyword_flood'], danmaku5s, gift10sRmb, null);
      highlight.score = Math.round(score * 100) / 100;
      highlight.title = '弹幕+关键词爆发';
      commitHighlight(now, highlight, 'Rule 2 danmaku_peak+keyword_flood (z=' + dZ.toFixed(2) + ' kw=' + keyword5s + ' ratio=' + keywordRatio.toFixed(2) + ')');
      return;
    }
  }

  function createHighlight(now, triggers, danmaku5s, gift10sRmb, audioPeakDb) {
    const startOffset = Math.max(0, now - recordingStartTime - 10);
    const endOffset = now - recordingStartTime + 5;
    return {
      startOffset: Math.round(startOffset * 100) / 100,
      endOffset: Math.round(endOffset * 100) / 100,
      duration: 15,
      score: 0,
      triggers: triggers,
      danmakuCount: danmaku5s,
      peakDanmakuRate: Math.round((danmaku5s / WINDOW_S) * 100) / 100,
      totalGiftValue: Math.round(gift10sRmb * 100) / 100,
      audioPeakDb: audioPeakDb,
      title: ''
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
        if (Math.abs(h.startOffset - peakOffset) < 15) {
          // Persist updates via HighlightStore.update
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

          // Keep our local reference in sync
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
        const startOffset = Math.round(peak.startOffset * 100) / 100;
        const endOffset = Math.round(peak.endOffset * 100) / 100;
        const highlight = {
          startOffset: startOffset,
          endOffset: endOffset,
          duration: Math.round((peak.endOffset - peak.startOffset) * 100) / 100,
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
    const baseline = baselineStats(danmakuBuckets, 'count', now, BASELINE_S);
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
