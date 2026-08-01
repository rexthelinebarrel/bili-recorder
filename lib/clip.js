const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Store = require('./store');
const logger = require('./logger');
const { FFMPEG_BIN, isValidMP4 } = require('./recorder');
const { DanmakuManager } = require('./danmaku-manager');
const { HighlightStore } = require('./highlight-store');
const { localDate } = require('./utils');

const AUTO_CLIP_TOP_N = 5;
const MIN_SOURCE_SIZE = 50 * 1024 * 1024;  // 源文件 < 50MB 视为重启碎片，自动换更大的录制文件

// ─── Source file selection ──────────────────────────────────────────────────

// 列出目录里的候选源文件：mp4、非切片、>50MB，按 "今日文件 ×10 加权" 的大小降序
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
    if (!f.endsWith('.mp4') || f.includes('_clip_')) continue;
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
    const srcOk = fs.statSync(filePath).size >= MIN_SOURCE_SIZE && isValidMP4(filePath);
    for (const fp of listSourceCandidates(path.dirname(filePath))) {
      if (fp !== filePath && isValidMP4(fp)) fallbackFiles.push(fp);
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
      '-ss', String(startOffset),
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

// 依次尝试 filesToTry 切出单个高光，成功后更新 HighlightStore。
// 返回 { clipFile, clipName, usedFallback }；全部失败则抛错。
async function clipHighlight({ streamerName, date, h, filesToTry, clipDir }) {
  let lastErr = null;
  for (const tryFile of filesToTry) {
    const tryExt = path.extname(tryFile);
    const clipName = path.basename(tryFile, tryExt) + '_clip_' + Math.floor(h.startOffset) + 's_' + Math.floor(h.endOffset) + 's' + tryExt;
    const clipPath = path.join(clipDir, clipName);
    try {
      await runFfmpegClip(tryFile, clipPath, h.startOffset, h.endOffset);
      HighlightStore.update(streamerName, date, h.id, { clipped: true, clipFile: clipPath });
      return { clipFile: clipPath, clipName, usedFallback: tryFile !== filesToTry[0] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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
  const { mainFile, fallbackFiles } = pickSourceFiles(filePath);
  const filesToTry = [mainFile, ...fallbackFiles];

  for (const h of highlights) {
    try {
      const r = await clipHighlight({ streamerName, date, h, filesToTry, clipDir });
      logger.info(`[auto-clip] ${r.clipName} (score=${h.score}, ${Math.floor(h.startOffset)}s-${Math.floor(h.endOffset)}s)` + (r.usedFallback ? ' [fallback]' : ''));
    } catch (e) {
      logger.error(`[auto-clip] Failed: ${h.id} — ${e.message}`);
    }
  }

  logger.info(`[auto-clip] Done for ${streamerName}`);
}

module.exports = { autoClipAfterStream, updateStreamerBaseline, listSourceCandidates, pickSourceFiles, clipHighlight, MIN_SOURCE_SIZE };
