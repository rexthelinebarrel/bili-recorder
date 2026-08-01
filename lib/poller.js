const path = require('path');
const Store = require('./store');
const logger = require('./logger');
const BiliAPI = require('./bili-api');
const { Recorder } = require('./recorder');
const { DanmakuManager } = require('./danmaku-manager');
const { autoClipAfterStream } = require('./clip');
const { finalizeStreamer } = require('./lifecycle');
const { mergeDirContents } = require('./utils');

const POLL_INTERVAL = 30_000;  // 30 seconds
const RECONNECT_WINDOW = 2 * 60 * 1000;  // 2 minutes
const GIVEUP_BACKOFF = 10 * 60 * 1000;  // 10 minutes before retrying after giveup
const OFFLINE_GRACE_PERIOD = 3 * 60 * 1000;  // 3 minutes — wait before confirming offline

const Poller = {
  _timer: null,
  _offlineSince: {},  // streamerId -> timestamp when first detected offline

  start() {
    this._timer = setInterval(() => this.check(), POLL_INTERVAL);
    this.check(); // immediate first check
  },

  async check() {
    const streamers = Store.getStreamers();
    for (const s of streamers) {
      try {
        const info = await BiliAPI.getRoomInfo(s.roomId);
        const prevStatus = s.status;

        // Update name if changed — migrate recordings from old directory
        if (info.name !== s.name) {
          const savePath = Store.getSettings().savePath;
          try {
            const count = mergeDirContents(path.join(savePath, s.name), path.join(savePath, info.name));
            if (count > 0) logger.info(`[poller] Migrated recordings: ${s.name} -> ${info.name} (${count} files)`);
          } catch (e) {
            logger.warn(`[poller] Failed to migrate recordings for ${s.name}: ${e.message}`);
          }
          s.name = info.name;
          Store.updateStreamer(s.id, { name: info.name });
        }

        if (info.status === 'live' && prevStatus === 'offline') {
          const realRoomId = info.roomId;
          logger.info(`[poller] ${s.name} (room ${s.roomId} real ${realRoomId}) went LIVE`);
          s.status = 'live';
          s.name = info.name;
          Store.updateStreamer(s.id, { status: 'live', name: info.name, lastLiveTime: Date.now(), realRoomId });
          try {
            const filePath = await Recorder.start(s.id, realRoomId, s.name);
            logger.info(`[recorder] Started recording ${s.name} -> ${filePath}`);
            Store.updateStreamer(s.id, { recording: true, lastFilePath: filePath });
            DanmakuManager.start(s.id, s.name, realRoomId);
          } catch (e) {
            logger.error(`[recorder] Failed to start for ${s.name}: ${e.message}`);
          }
        } else if (info.status === 'live' && prevStatus === 'live') {
          if (this._offlineSince[s.id]) {
            logger.info(`[poller] ${s.name} back online — false alarm canceled`);
            delete this._offlineSince[s.id];
          }
          if (!Recorder.isRecording(s.id)) {
            if (s.gaveUpAt && (Date.now() - s.gaveUpAt) < GIVEUP_BACKOFF) {
              // still in backoff, skip reconnect attempt
            } else {
              const lastLive = s.lastLiveTime || 0;
              const gap = Date.now() - lastLive;
              if (gap <= RECONNECT_WINDOW) {
                logger.warn(`[recorder] Reconnecting ${s.name} (gap: ${Math.round(gap/1000)}s, reusing file)`);
                const realRoomId = s.realRoomId || info.roomId;
                try {
                  await Recorder.start(s.id, realRoomId, s.name, s.lastFilePath);
                  Store.updateStreamer(s.id, { recording: true, lastLiveTime: Date.now(), gaveUpAt: null });
                  if (!DanmakuManager.isRunning(s.id)) {
                    DanmakuManager.start(s.id, s.name, realRoomId);
                  }
                } catch (e) {
                  logger.warn(`[recorder] Reconnect failed for ${s.name}: ${e.message}`);
                }
              } else {
                logger.warn(`[recorder] ${s.name} recorder dead >2min, giving up`);
                Store.updateStreamer(s.id, { recording: false, gaveUpAt: Date.now() });
              }
            }
          } else {
            s.lastLiveTime = Date.now();
            if (!DanmakuManager.isRunning(s.id) && s.realRoomId) {
              DanmakuManager.start(s.id, s.name, s.realRoomId);
            }
          }
        }

        if (info.status === 'offline' && s.status === 'live') {
          if (!this._offlineSince[s.id]) {
            this._offlineSince[s.id] = Date.now();
            logger.info(`[poller] ${s.name} went OFFLINE, waiting ${OFFLINE_GRACE_PERIOD / 60000}min to confirm...`);
          }
        }

        if (this._offlineSince[s.id]) {
          const elapsed = Date.now() - this._offlineSince[s.id];
          if (elapsed >= OFFLINE_GRACE_PERIOD) {
            logger.info(`[poller] ${s.name} confirmed offline after ${Math.round(elapsed / 1000)}s`);
            delete this._offlineSince[s.id];

            const stoppedFile = Recorder.isRecording(s.id)
              ? await Recorder.stop(s.id)
              : Recorder.getLastExitedFile(s.id);
            if (stoppedFile) logger.info(`[recorder] Stopped recording: ${stoppedFile}`);
            await finalizeStreamer(s.id, stoppedFile);
            Store.updateStreamer(s.id, { status: 'offline', recording: false });

            if (stoppedFile) {
              await autoClipAfterStream(s.name, stoppedFile);
            }
          }
        }

      } catch (e) {
        logger.warn(`[poller] Error checking room ${s.roomId}: ${e.message}`);
      }
    }
  },

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
};

module.exports = { Poller };
