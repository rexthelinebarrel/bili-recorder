const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Store = require('./store');
const logger = require('./logger');
const { Recorder, FFMPEG_BIN, isValidMP4, findBestSourceFile } = require('./recorder');
const { DanmakuManager } = require('./danmaku-manager');
const { HighlightStore } = require('./highlight-store');
const { analyzeAudio } = require('./audio-analyzer');

const AUTO_CLIP_TOP_N = 5;

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
      updatedAt: new Date().toISOString().slice(0, 10),
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

  const date = new Date().toISOString().slice(0, 10);
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
  const srcExt = path.extname(filePath);

  let mainFile = filePath;
  const fallbackFiles = [];
  try {
    const srcSize = fs.statSync(filePath).size;
    const dir = path.dirname(filePath);
    const todayStr = new Date().toISOString().slice(0, 10);
    const candidates = fs.readdirSync(dir)
      .filter(f => f.endsWith('.mp4') && !f.includes('_clip_'))
      .map(f => path.join(dir, f))
      .filter(fp => {
        try { return fs.statSync(fp).size > 50 * 1024 * 1024; } catch { return false; }
      })
      .sort((a, b) => {
        const sa = (a.includes(todayStr) ? 10 : 1) * fs.statSync(a).size;
        const sb = (b.includes(todayStr) ? 10 : 1) * fs.statSync(b).size;
        return sb - sa;
      });
    for (const fp of candidates) {
      if (fp !== filePath && isValidMP4(fp)) fallbackFiles.push(fp);
    }
    if (srcSize < 50 * 1024 * 1024 || !isValidMP4(filePath)) {
      if (fallbackFiles.length > 0) {
        mainFile = fallbackFiles.shift();
        logger.info(`[auto-clip] Switching source to ${path.basename(mainFile)}`);
      }
    }
  } catch {}

  for (const h of highlights) {
    const filesToTry = [mainFile, ...fallbackFiles];
    let clippingDone = false;
    for (const tryFile of filesToTry) {
      const tryExt = path.extname(tryFile);
      const clipName = path.basename(tryFile, tryExt) + '_clip_' + Math.floor(h.startOffset) + 's_' + Math.floor(h.endOffset) + 's' + tryExt;
      const clipPath = path.join(clipDir, clipName);

      try {
        await new Promise((resolve, reject) => {
          const args = [
            '-ss', String(h.startOffset),
            '-to', String(h.endOffset),
            '-i', tryFile,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-y', clipPath
          ];
          const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' });
          proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          proc.on('error', reject);
        });

        HighlightStore.update(streamerName, date, h.id, { clipped: true, clipFile: clipPath });
        logger.info(`[auto-clip] ${clipName} (score=${h.score}, ${Math.floor(h.startOffset)}s-${Math.floor(h.endOffset)}s)` + (tryFile !== mainFile ? ' [fallback]' : ''));
        clippingDone = true;
        break;
      } catch (e) {
        if (tryFile === filesToTry[filesToTry.length - 1]) {
          logger.error(`[auto-clip] Failed: ${h.id} — ${e.message}`);
        }
      }
    }
    if (!clippingDone) continue;
  }

  logger.info(`[auto-clip] Done for ${streamerName}`);
}

module.exports = { autoClipAfterStream, updateStreamerBaseline };
