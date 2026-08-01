const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Store = require('./store');
const logger = require('./logger');
const { FFMPEG_BIN, VIDEO_EXTS, isValidVideo, getVideoDuration } = require('./recorder');
const { DanmakuManager } = require('./danmaku-manager');
const { HighlightStore } = require('./highlight-store');
const { localDate } = require('./utils');

const AUTO_CLIP_TOP_N = 5;
const MIN_SOURCE_SIZE = 50 * 1024 * 1024;  // 启发式选源时，< 50MB 视为重启碎片
const MIN_CLIP_SIZE = 1024 * 1024;         // 切片产物 < 1MB 视为失败（偏移多半超出文件范围）
const CLIP_WINDOW_BEFORE_S = 300;  // 与 highlight-engine 的 CLIP_BEFORE_S 一致
const CLIP_WINDOW_AFTER_S = 300;

// ─── 分片表：墙钟时间 → (文件, 文件内偏移) ──────────────────────────────────
//
// 高光偏移有两种基准：
//   - 弹幕/礼物高光带 peakTs（墙钟秒）→ 经 segments.json 映射到对应分片
//   - 音频高光带 sourceFile → 偏移本来就是该文件内的，直接切
// 都没有（旧数据）时退回"最大有效文件"启发式。

function loadSegments(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'segments.json'), 'utf-8'));
    return Array.isArray(data.segments) ? data.segments : [];
  } catch {
    return [];
  }
}

function mapWallRangeToSegment(segments, wallStart, wallEnd) {
  for (const seg of segments) {
    const segEnd = seg.endTs == null ? Infinity : seg.endTs;
    if (wallStart >= seg.startTs && wallStart < segEnd) {
      return {
        filePath: seg.filePath,
        startOffset: wallStart - seg.startTs,
        endOffset: Math.min(wallEnd, segEnd) - seg.startTs
      };
    }
  }
  return null;
}

// 为高光的切割生成候选源列表（按可靠性从高到低）。返回 [] 表示无法定位
function buildSources(h, defaultFile, segments) {
  // 1. 音频高光：偏移是 sourceFile 文件内的
  if (h.sourceFile) {
    return [{ filePath: h.sourceFile, startOffset: h.startOffset, endOffset: h.endOffset }];
  }
  // 2. 墙钟映射：弹幕/礼物高光
  if (h.peakTs && segments.length > 0) {
    const m = mapWallRangeToSegment(segments, h.peakTs - CLIP_WINDOW_BEFORE_S, h.peakTs + CLIP_WINDOW_AFTER_S);
    if (m) return [m];
    logger.warn(`[clip] No segment covers peakTs=${h.peakTs} for highlight ${h.id || '?'}, falling back to heuristic`);
  }
  // 3. 启发式兜底（旧数据）：默认文件 + 最大有效候选，用全局偏移
  if (!defaultFile) return [];
  const { mainFile, fallbackFiles } = pickSourceFiles(defaultFile);
  return [mainFile, ...fallbackFiles].map(f => ({ filePath: f, startOffset: h.startOffset, endOffset: h.endOffset }));
}

// ─── 启发式源文件选择（兜底路径用） ─────────────────────────────────────────

// 列出目录里的候选源文件：视频格式、非切片、>50MB，按 "今日文件 ×10 加权" 的大小降序
function listSourceCandidates(dir) {
  const todayStr = localDate();
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!VIDEO_EXTS.has(path.extname(f).toLowerCase()) || f.includes('_clip_')) continue;
    const fp = path.join(dir, f);
    try {
      const st = fs.statSync(fp);
      if (st.size > MIN_SOURCE_SIZE) {
        out.push({ fp, score: st.size * (f.includes(todayStr) ? 10 : 1) });
      }
    } catch {}
  }
  return out.sort((a, b) => b.score - a.score).map(c => c.fp);
}

// 选定主源文件 + 备选列表。主文件太小或损坏时自动切换到最大的有效候选。
function pickSourceFiles(filePath) {
  let mainFile = filePath;
  const fallbackFiles = [];
  try {
    const srcOk = fs.statSync(filePath).size >= MIN_SOURCE_SIZE && isValidVideo(filePath);
    for (const fp of listSourceCandidates(path.dirname(filePath))) {
      if (fp !== filePath && isValidVideo(fp)) fallbackFiles.push(fp);
    }
    if (!srcOk && fallbackFiles.length > 0) {
      mainFile = fallbackFiles.shift();
      logger.info(`[clip] Switching source to ${path.basename(mainFile)}`);
    }
  } catch (e) {
    logger.warn(`[clip] Source scan failed for ${filePath}: ${e.message}`);
  }
  return { mainFile, fallbackFiles };
}

// ─── Single highlight clipping ──────────────────────────────────────────────

function runFfmpegClip(srcFile, clipPath, startOffset, endOffset) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(Math.max(0, startOffset)),
      '-to', String(endOffset),
      '-i', srcFile,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-y', clipPath
    ];
    const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' });
    proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
    proc.on('error', reject);
  });
}

// 依次尝试 sources 切出单个高光：
// - endOffset 先用 ffprobe 实际时长钳制（临近下播的高光常超出文件时长）
// - 产物 < MIN_CLIP_SIZE 视为失败（ffmpeg 对超范围偏移会静默产空文件）
// 成功后更新 HighlightStore，返回 { clipFile, clipName, usedFallback }；全部失败则抛错。
async function clipHighlight({ streamerName, date, h, sources, clipDir }) {
  let lastErr = null;
  for (const src of sources) {
    if (!fs.existsSync(src.filePath)) {
      lastErr = new Error('source not found: ' + src.filePath);
      continue;
    }
    const srcExt = path.extname(src.filePath);
    const clipName = path.basename(src.filePath, srcExt) + '_clip_' + Math.floor(src.startOffset) + 's_' + Math.floor(src.endOffset) + 's' + srcExt;
    const clipPath = path.join(clipDir, clipName);
    try {
      let endOffset = src.endOffset;
      const duration = getVideoDuration(src.filePath);
      if (duration != null && endOffset > duration) {
        endOffset = Math.max(src.startOffset, duration);
        logger.info(`[clip] Clamped endOffset ${src.endOffset.toFixed(0)}s -> ${endOffset.toFixed(0)}s (file duration)`);
      }
      await runFfmpegClip(src.filePath, clipPath, src.startOffset, endOffset);

      const size = fs.statSync(clipPath).size;
      if (size < MIN_CLIP_SIZE) {
        try { fs.unlinkSync(clipPath); } catch {}
        throw new Error(`clip output too small (${size}B), offset likely out of range`);
      }

      HighlightStore.update(streamerName, date, h.id, { clipped: true, clipFile: clipPath });
      return { clipFile: clipPath, clipName, usedFallback: src !== sources[0] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no usable source');
}

// ─── Baseline update ────────────────────────────────────────────────────────

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

  const alpha = 0.3;
  const newMean = old.meanDanmakuRate * (1 - alpha) + sessionStats.mean * alpha;
  const newStd = old.stdDanmakuRate * (1 - alpha) + sessionStats.std * alpha;
  const newCount = old.sampleCount + 1;

  Store.updateStreamer(streamerId, {
    baseline: {
      meanDanmakuRate: Math.round(newMean * 10000) / 10000,
      stdDanmakuRate: Math.round(newStd * 10000) / 10000,
      updatedAt: localDate(),
      sampleCount: newCount
    }
  });

  logger.info(`[baseline] Updated ${streamerName}: mean=${newMean.toFixed(3)} std=${newStd.toFixed(3)} n=${newCount}`);
}

// ─── Auto-clip after stream ends ────────────────────────────────────────────

async function autoClipAfterStream(streamerName, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    logger.warn(`[auto-clip] File not found for ${streamerName}: ${filePath}`);
    return;
  }

  const date = localDate();
  const data = HighlightStore.getAll(streamerName, date);
  const highlights = (data.highlights || [])
    .filter(h => !h.clipped)
    .sort((a, b) => b.score - a.score)
    .slice(0, AUTO_CLIP_TOP_N);

  if (highlights.length === 0) {
    logger.info(`[auto-clip] No unclipped highlights for ${streamerName} on ${date}`);
    return;
  }

  logger.info(`[auto-clip] Clipping ${highlights.length} highlights for ${streamerName}...`);

  const clipDir = path.dirname(filePath);
  const segments = loadSegments(clipDir);

  for (const h of highlights) {
    const sources = buildSources(h, filePath, segments);
    try {
      const r = await clipHighlight({ streamerName, date, h, sources, clipDir });
      logger.info(`[auto-clip] ${r.clipName} (score=${h.score}, ${Math.floor(h.startOffset)}s-${Math.floor(h.endOffset)}s)` + (r.usedFallback ? ' [fallback]' : ''));
    } catch (e) {
      logger.error(`[auto-clip] Failed: ${h.id} — ${e.message}`);
    }
  }

  logger.info(`[auto-clip] Done for ${streamerName}`);
}

module.exports = {
  autoClipAfterStream,
  updateStreamerBaseline,
  listSourceCandidates,
  pickSourceFiles,
  clipHighlight,
  loadSegments,
  mapWallRangeToSegment,
  buildSources,
  MIN_SOURCE_SIZE,
  MIN_CLIP_SIZE
};
