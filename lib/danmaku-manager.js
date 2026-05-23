const https = require('https');
const Store = require('./store');
const logger = require('./logger');
const { Recorder } = require('./recorder');
const { createDanmakuParser } = require('./danmaku-parser');
const { createHighlightEngine } = require('./highlight-engine');

// ─── REST Danmaku Poller (fallback when WebSocket can't receive danmaku) ────

const REST_DANMAKU_INTERVAL = 8_000;  // 8 seconds

const RESTDanmakuPoller = {
  _timers: {},      // streamerId -> interval timer
  _lastTime: {},    // streamerId -> last seen timeline (dedup)

  start(streamerId, roomId, engine) {
    if (this._timers[streamerId]) return;
    this._lastTime[streamerId] = '1970-01-01 00:00:00';

    const poll = async () => {
      try {
        const url = `https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${roomId}`;
        const res = await new Promise((resolve, reject) => {
          https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://live.bilibili.com/' } }, (resp) => {
            let data = '';
            resp.on('data', c => data += c);
            resp.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        if (res.code !== 0 || !res.data) return;

        const roomMsgs = res.data.room || [];
        const lastTime = this._lastTime[streamerId];
        let newCount = 0;

        for (const m of roomMsgs) {
          if (m.timeline <= lastTime) continue;
          if (m.timeline > lastTime) this._lastTime[streamerId] = m.timeline;
          if (m.text) engine.feedDanmaku(m.text);
          newCount++;
        }
        if (newCount > 0) {
          logger.info(`[rest-danmaku] ${newCount} new danmaku for room ${roomId}`);
        }
      } catch {}
    };

    poll(); // immediate first poll
    this._timers[streamerId] = setInterval(poll, REST_DANMAKU_INTERVAL);
  },

  stop(streamerId) {
    if (this._timers[streamerId]) {
      clearInterval(this._timers[streamerId]);
      delete this._timers[streamerId];
    }
    delete this._lastTime[streamerId];
  }
};

// ─── Danmaku Manager ────────────────────────────────────────────────────────

const DanmakuManager = {
  _engines: {},   // streamerId -> HighlightEngine
  _parsers: {},   // streamerId -> DanmakuParser

  start(streamerId, streamerName, roomId) {
    if (this._parsers[streamerId]) return;
    const streamer = Store.getStreamers().find(s => s.id === streamerId);
    const emotionDict = (streamer && streamer.emotionDict) || Store._data.emotionDict || null;
    const engine = createHighlightEngine(streamerId, streamerName, roomId, logger, emotionDict);
    const parser = createDanmakuParser(roomId, logger);
    this._engines[streamerId] = engine;
    this._parsers[streamerId] = parser;

    const startTime = Recorder.getStreamStartTime(streamerId) || Date.now() / 1000;
    engine.setRecordingStart(startTime);

    if (streamer && streamer.baseline && streamer.baseline.sampleCount > 0) {
      engine.setBaseline(streamer.baseline);
      logger.info(`[danmaku] Loaded baseline for ${streamerName} (n=${streamer.baseline.sampleCount}, mean=${streamer.baseline.meanDanmakuRate.toFixed(2)})`);
    }

    parser.on('danmaku', (d) => engine.feedDanmaku(d.text, d.uid));
    parser.on('gift', (d) => engine.feedGift(d.rmb));
    parser.on('guard', (d) => engine.feedGuard(d.guardLevel, d.guardName, d.rmb));
    parser.on('close', () => {
      logger.warn(`[danmaku] Parser closed for ${streamerName}`);
      delete this._parsers[streamerId];
    });
    parser.on('error', (d) => logger.warn(`[danmaku] Error for ${streamerName}: ${d.message}`));

    parser.start().catch(e => {
      logger.error(`[danmaku] Failed to start for ${streamerName}: ${e.message}`);
      delete this._parsers[streamerId];
      delete this._engines[streamerId];
    });
    logger.info(`[danmaku] Started for ${streamerName} (room ${roomId})`);

    RESTDanmakuPoller.start(streamerId, roomId, engine);
  },

  stop(streamerId) {
    const parser = this._parsers[streamerId];
    if (parser) { parser.stop(); delete this._parsers[streamerId]; }
    RESTDanmakuPoller.stop(streamerId);
    if (this._engines[streamerId]) delete this._engines[streamerId];
  },

  getEngine(streamerId) { return this._engines[streamerId] || null; },
  isRunning(streamerId) { return !!this._parsers[streamerId]; }
};

module.exports = { DanmakuManager, RESTDanmakuPoller };
