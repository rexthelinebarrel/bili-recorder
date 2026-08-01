// lifecycle.js — 录制停止后的统一收尾流程
// 之前这段逻辑在 api-router (/stop, /shutdown, /exit) 和 poller 里重复了 4 次
const Store = require('./store');
const logger = require('./logger');
const { Recorder } = require('./recorder');
const { DanmakuManager, RESTDanmakuPoller } = require('./danmaku-manager');
const { analyzeAudio } = require('./audio-analyzer');
const { autoClipAfterStream, updateStreamerBaseline } = require('./clip');

// 停止录制后的收尾：音频分析回灌 → 停弹幕 → 更新主播弹幕基线
// 注意：调用方需先自行 Recorder.stop() 拿到 stoppedFile
async function finalizeStreamer(streamerId, stoppedFile) {
  const engine = DanmakuManager.getEngine(streamerId);
  if (engine && stoppedFile) {
    try {
      const peaks = await analyzeAudio(stoppedFile, logger);
      if (peaks.length > 0) engine.feedAudioResult(peaks);
    } catch (e) {
      logger.warn(`[audio] Analysis failed: ${e.message}`);
    }
  }
  DanmakuManager.stop(streamerId);
  RESTDanmakuPoller.stop(streamerId);
  const s = Store.getStreamers().find(s => s.id === streamerId);
  if (s) updateStreamerBaseline(streamerId, s.name);
}

// 停止所有在录的主播并逐个收尾 + 自动切片（/api/shutdown 和 /api/exit 共用）
async function cleanupAllRecordings(tag) {
  for (const sid of Recorder.activeIds()) {
    try {
      const stoppedFile = await Recorder.stop(sid);
      await finalizeStreamer(sid, stoppedFile);
      if (stoppedFile) {
        const s = Store.getStreamers().find(x => x.id === sid);
        if (s) {
          try {
            await autoClipAfterStream(s.name, stoppedFile);
          } catch (e) {
            logger.warn(`[clip] Auto-clip failed for ${s.name}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.error(`[${tag}] Error cleaning up streamer ${sid}: ${e.message}`);
    }
  }
  // 兜底：停掉残留的弹幕连接
  for (const sid of DanmakuManager.activeIds()) {
    try { DanmakuManager.stop(sid); } catch {}
  }
}

module.exports = { finalizeStreamer, cleanupAllRecordings };
