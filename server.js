const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('./lib/logger');
const Store = require('./lib/store');
const { handleRequest } = require('./lib/api-router');
const { Poller } = require('./lib/poller');

// ─── Migrate orphaned recording directories ─────────────────────────────────

function migrateOrphanedDirs() {
  const savePath = Store.getSettings().savePath;
  const streamers = Store.getStreamers();
  try {
    const entries = fs.readdirSync(savePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      for (const s of streamers) {
        if (dirName === s.name) break;
        if (dirName === s.roomId || dirName === '房间' + s.roomId) {
          const oldDir = path.join(savePath, dirName);
          const newDir = path.join(savePath, s.name);
          try {
            fs.mkdirSync(newDir, { recursive: true });
            const files = fs.readdirSync(oldDir);
            for (const f of files) {
              fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
            }
            fs.rmdirSync(oldDir);
            logger.info(`[migrate] Merged orphaned dir ${dirName} -> ${s.name} (${files.length} files)`);
          } catch (e) {
            logger.warn(`[migrate] Failed to merge ${dirName}: ${e.message}`);
          }
          break;
        }
      }
    }
  } catch {}
}

// ─── Startup ────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
const PORT = process.env.PORT || 3456;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Close the existing server first, or run: taskkill /F /IM node.exe`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  // Reset stale recording state from previous server run
  for (const s of Store.getStreamers()) {
    if (s.recording || s.status === 'live') {
      Store.updateStreamer(s.id, { status: 'offline', recording: false });
      logger.info(`[init] Reset ${s.name} to offline (server restart)`);
    }
  }
  // Ensure all streamers have format and quality fields
  const defaultFmt = Store.getSettings().format || 'flv';
  for (const s of Store.getStreamers()) {
    const updates = {};
    if (!s.format) updates.format = defaultFmt;
    if (!s.quality) updates.quality = 'auto';
    if (Object.keys(updates).length > 0) Store.updateStreamer(s.id, updates);
  }
  migrateOrphanedDirs();
  logger.info(`Bili Recorder running at http://localhost:${PORT}`);
  Poller.start();
});
