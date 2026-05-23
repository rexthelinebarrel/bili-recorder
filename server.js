const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const { createDanmakuParser } = require('./lib/danmaku-parser');
const { createHighlightEngine } = require('./lib/highlight-engine');
const { HighlightStore } = require('./lib/highlight-store');
const { analyzeAudio } = require('./lib/audio-analyzer');

const logger = require('./lib/logger');
const Store = require('./lib/store');
const BiliAPI = require('./lib/bili-api');

const { Recorder, getFfmpegArgs, FFMPEG_BIN, FFPROBE_BIN, VIDEO_EXTS, isValidMP4, findBestSourceFile } = require('./lib/recorder');
logger.info(`ffmpeg: ${FFMPEG_BIN}`);

const { autoClipAfterStream, updateStreamerBaseline } = require('./lib/clip');

// ─── REST Danmaku Poller (fallback when WebSocket can't receive danmaku) ────────
const { DanmakuManager } = require('./lib/danmaku-manager');

const { Poller } = require('./lib/poller');

// ─── HTTP Server ────────────────────────────────────────────────────────────────

function parseJSON(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Static files
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }

  // API routes
  if (url.pathname === '/api/status' && req.method === 'GET') {
    const streamers = Store.getStreamers();
    const recordings = [];
    const orphaned = [];
    const savePath = Store.getSettings().savePath;
    const streamerNames = new Set(streamers.map(s => s.name));
    for (const s of streamers) {
      const dir = path.join(savePath, s.name);
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) {
            const stat = fs.statSync(path.join(dir, f));
            recordings.push({ filename: s.name + '/' + f, streamerId: s.id, size: stat.size, mtime: stat.mtimeMs, filePath: path.join(dir, f) });
          }
        }
      } catch {}
    }
    // Orphaned: files in directories that don't match any streamer
    try {
      const entries = fs.readdirSync(savePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (streamerNames.has(entry.name)) continue;
        const dir = path.join(savePath, entry.name);
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) {
            const stat = fs.statSync(path.join(dir, f));
            orphaned.push({ filename: entry.name + '/' + f, size: stat.size, mtime: stat.mtimeMs, filePath: path.join(dir, f) });
          }
        }
      }
    } catch {}
    recordings.sort((a, b) => b.mtime - a.mtime);
    orphaned.sort((a, b) => b.mtime - a.mtime);
    sendJSON(res, 200, { streamers, recordings, orphaned });
    return;
  }

  if (url.pathname === '/api/streamer' && req.method === 'POST') {
    const body = await parseJSON(req);
    const input = String(body.roomId || '').trim();
    if (!input) {
      sendJSON(res, 400, { error: 'Invalid input' });
      return;
    }

    let roomId = null;
    // 1. Pure number: direct room ID
    if (/^\d+$/.test(input)) {
      roomId = input;
    }
    // 2. live.bilibili.com/<room_id> URL
    else {
      const urlMatch = input.match(/live\.bilibili\.com\/(\d+)/);
      if (urlMatch) roomId = urlMatch[1];
    }
    // 3. b23.tv short link
    if (!roomId && /b23\.tv/.test(input)) {
      try {
        let shortUrl = input;
        if (!shortUrl.startsWith('http')) shortUrl = 'https://' + shortUrl;
        const redirected = await new Promise((resolve, reject) => {
          https.get(shortUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
            const loc = resp.headers.location || '';
            const match = loc.match(/live\.bilibili\.com\/(\d+)/);
            resolve(match ? match[1] : null);
          }).on('error', reject);
        });
        if (redirected) roomId = redirected;
      } catch {}
    }
    // 4. URL path ending in just the room ID (e.g., https://space.bilibili.com/... but that's UID)
    // For now, skip. Could add UID lookup later via API.

    if (!roomId) {
      sendJSON(res, 400, { error: '无法识别房间号，请输入纯数字房间号、live.bilibili.com 链接或 b23.tv 短链' });
      return;
    }
    if (Store.getStreamers().find(s => s.roomId === roomId)) {
      sendJSON(res, 409, { error: 'Streamer already added' });
      return;
    }
    const defaultFmt = Store.getSettings().format || 'flv';
    const s = { id: Date.now().toString(), roomId, name: roomId, status: 'offline', recording: false, quality: 'auto', format: defaultFmt };
    Store.addStreamer(s);
    // Fetch name and live status immediately
    try {
      const info = await BiliAPI.getRoomInfo(roomId);
      // Merge any recordings left in old directory names
      const savePath = Store.getSettings().savePath;
      for (const oldName of [roomId, '房间' + roomId]) {
        if (oldName === info.name) continue;
        const oldDir = path.join(savePath, oldName);
        const newDir = path.join(savePath, info.name);
        try {
          if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
            fs.mkdirSync(newDir, { recursive: true });
            const files = fs.readdirSync(oldDir);
            for (const f of files) {
              fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
            }
            fs.rmdirSync(oldDir);
            logger.info(`[add] Merged orphaned dir ${oldName} -> ${info.name} (${files.length} files)`);
          }
        } catch {}
      }
      s.name = info.name;
      Store.updateStreamer(s.id, { name: info.name, realRoomId: info.roomId });

      // If streamer is already live, start recording immediately
      if (info.status === 'live') {
        const realRoomId = info.roomId;
        logger.info(`[add] ${s.name} is LIVE, starting recording immediately`);
        s.status = 'live';
        Store.updateStreamer(s.id, { status: 'live', lastLiveTime: Date.now(), realRoomId });
        try {
          const filePath = await Recorder.start(s.id, realRoomId, s.name);
          logger.info(`[recorder] Started recording ${s.name} -> ${filePath}`);
          Store.updateStreamer(s.id, { recording: true, lastFilePath: filePath });
          DanmakuManager.start(s.id, s.name, realRoomId);
        } catch (e) {
          logger.error(`[recorder] Failed to start for ${s.name}: ${e.message}`);
        }
      }
    } catch {}
    sendJSON(res, 201, s);
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/start') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    if (Recorder.isRecording(id)) {
      sendJSON(res, 400, { error: 'Already recording' });
      return;
    }
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    const realRoomId = s.realRoomId || s.roomId;
    try {
      await Recorder.start(id, realRoomId, s.name);
      Store.updateStreamer(id, { recording: true, lastLiveTime: Date.now() });
      const s2 = Store.getStreamers().find(s => s.id === id);
      if (s2 && !DanmakuManager.isRunning(id)) {
        DanmakuManager.start(id, s2.name, s2.realRoomId || s2.roomId);
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/stop') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    if (Recorder.isRecording(id)) {
      const stoppedFile = await Recorder.stop(id);
      const engine = DanmakuManager.getEngine(id);
      if (engine && stoppedFile) {
        try {
          const peaks = await analyzeAudio(stoppedFile, logger);
          if (peaks.length > 0) engine.feedAudioResult(peaks);
        } catch (e) {
          logger.warn(`[audio] Analysis failed: ${e.message}`);
        }
      }
      DanmakuManager.stop(id);
      RESTDanmakuPoller.stop(id);
      const s2 = Store.getStreamers().find(s => s.id === id);
      if (s2) updateStreamerBaseline(id, s2.name);
      Store.updateStreamer(id, { recording: false });
      sendJSON(res, 200, { ok: true });

      // 手动停止录制也触发切片
      if (stoppedFile) {
        const s = Store.getStreamers().find(s => s.id === id);
        if (s) await autoClipAfterStream(s.name, stoppedFile);
      }
    } else {
      sendJSON(res, 400, { error: 'Not recording' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/quality') && req.method === 'PUT') {
    const id = url.pathname.split('/')[3];
    const body = await parseJSON(req);
    const quality = body.quality;
    if (!['auto', 'high', 'medium', 'low'].includes(quality)) {
      sendJSON(res, 400, { error: 'Invalid quality. Use: auto, high, medium, low' });
      return;
    }
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    s.quality = quality;
    Store.updateStreamer(id, { quality });
    sendJSON(res, 200, { ok: true, quality });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/emotion-dict') && req.method === 'GET') {
    const id = url.pathname.split('/')[3];
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    sendJSON(res, 200, s.emotionDict || null);
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/emotion-dict') && req.method === 'PUT') {
    const id = url.pathname.split('/')[3];
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    const body = await parseJSON(req);
    Store.updateStreamer(id, { emotionDict: body });
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/format') && req.method === 'PUT') {
    const id = url.pathname.split('/')[3];
    const body = await parseJSON(req);
    const format = body.format;
    if (!['flv', 'mkv', 'ts', 'mp4'].includes(format)) {
      sendJSON(res, 400, { error: 'Invalid format. Use: flv, mkv, ts, mp4' });
      return;
    }
    const s = Store.getStreamers().find(s => s.id === id);
    if (!s) { sendJSON(res, 404, { error: 'Streamer not found' }); return; }
    s.format = format;
    Store.updateStreamer(id, { format });
    sendJSON(res, 200, { ok: true, format });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    const deleteFiles = url.searchParams.get('deleteFiles') === 'true';
    const streamer = Store.getStreamers().find(s => s.id === id);
    const streamerName = streamer ? streamer.name : null;
    if (Recorder.isRecording(id)) await Recorder.stop(id);
    DanmakuManager.stop(id);
    Store.removeStreamer(id);
    if (deleteFiles && streamerName) {
      const savePath = Store.getSettings().savePath;
      const dir = path.join(savePath, streamerName);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.info(`[streamer] Deleted recording dir for ${streamerName}: ${dir}`);
      } catch (e) {
        logger.warn(`[streamer] Failed to delete dir for ${streamerName}: ${e.message}`);
      }
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    sendJSON(res, 200, Store.getSettings());
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await parseJSON(req);
    Store.updateSettings(body);
    sendJSON(res, 200, Store.getSettings());
    return;
  }

  if (url.pathname === '/api/check' && req.method === 'POST') {
    Poller.check();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/convert' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath || !fs.existsSync(filePath)) { sendJSON(res, 400, { error: 'File not found' }); return; }
    if (Recorder._processes && Object.values(Recorder._processes).some(e => e.filePath === filePath)) {
      sendJSON(res, 409, { error: '文件正在录制中，请先停止再转换' });
      return;
    }
    const newPath = filePath.replace(/\.flv$/i, '.mkv');
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, ['-i', filePath, '-c', 'copy', '-y', newPath], { stdio: 'ignore' });
        proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
        proc.on('error', reject);
      });
      logger.info(`[convert] ${filePath} -> ${newPath}`);
      sendJSON(res, 200, { ok: true, newPath });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/open-file' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath) { sendJSON(res, 400, { error: 'Missing filePath' }); return; }
    try {
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        const vlcPaths = [
          'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
          'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
        ];
        const fs = require('fs');
        const vlc = vlcPaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
        if (vlc) {
          execFile(vlc, [filePath]);
        } else {
          execFile('cmd', ['/c', 'start', '', filePath]);
        }
      } else if (process.platform === 'darwin') {
        execFile('open', [filePath]);
      } else {
        execFile('xdg-open', [filePath]);
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Open folder & select file in Explorer
  if (url.pathname === '/api/open-folder' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath) { sendJSON(res, 400, { error: 'Missing filePath' }); return; }
    try {
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        execFile('explorer', ['/select,', filePath]);
      } else if (process.platform === 'darwin') {
        execFile('open', ['-R', filePath]);
      } else {
        execFile('xdg-open', [require('path').dirname(filePath)]);
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/recording' && req.method === 'DELETE') {
    const filePath = url.searchParams.get('filePath');
    if (!filePath) { sendJSON(res, 400, { error: 'Missing filePath' }); return; }
    // Check if any active recorder is writing to this file
    for (const [sid, entry] of Object.entries(Recorder._processes)) {
      if (entry.filePath === filePath) {
        sendJSON(res, 409, { error: '文件正在录制中，请先停止录制再删除' });
        return;
      }
    }
    try {
      fs.unlinkSync(filePath);
      logger.info(`[recording] Deleted: ${filePath}`);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    sendJSON(res, 200, { ok: true });
    logger.info('Server shutting down by user request...');
    Poller.stop();

    // Stop all recordings with audio analysis + auto-clip
    for (const [sid] of Object.entries(Recorder._processes)) {
      const stoppedFile = await Recorder.stop(sid);
      const engine = DanmakuManager.getEngine(sid);
      if (engine && stoppedFile) {
        try {
          const peaks = await analyzeAudio(stoppedFile, logger);
          if (peaks.length > 0) engine.feedAudioResult(peaks);
        } catch (e) {
          logger.warn(`[audio] Analysis failed: ${e.message}`);
        }
      }
      DanmakuManager.stop(sid);
      RESTDanmakuPoller.stop(sid);
      const streamer2 = Store.getStreamers().find(s => s.id === sid);
      if (streamer2) updateStreamerBaseline(sid, streamer2.name);
      if (stoppedFile) {
        const streamer = Store.getStreamers().find(s => s.id === sid);
        if (streamer) await autoClipAfterStream(streamer.name, stoppedFile);
      }
    }

    for (const [sid] of Object.entries(DanmakuManager._parsers)) {
      DanmakuManager.stop(sid);
    }
    process.exit(0);
    return;
  }

  // ─── Emotion Dictionary API ─────────────────────────────────────────────────

  if (url.pathname === '/api/emotion-dict' && req.method === 'GET') {
    const dict = Store._data.emotionDict || {};
    sendJSON(res, 200, dict);
    return;
  }

  if (url.pathname === '/api/emotion-dict' && req.method === 'PUT') {
    const body = await parseJSON(req);
    Store._data.emotionDict = body;
    Store.save();
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ─── Highlight APIs ──────────────────────────────────────────────────────────

  if (url.pathname === '/api/highlights' && req.method === 'GET') {
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!streamerName) { sendJSON(res, 400, { error: 'Missing streamerName' }); return; }
    const data = HighlightStore.getAll(streamerName, date);
    const dates = HighlightStore.listDates(streamerName);
    sendJSON(res, 200, { ...data, availableDates: dates });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date');
    if (!streamerName || !date) { sendJSON(res, 400, { error: 'Missing streamerName or date' }); return; }
    sendJSON(res, HighlightStore.remove(streamerName, date, id) ? 200 : 404, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    const body = await parseJSON(req);
    const { streamerName, date, startOffset, endOffset } = body;
    if (!streamerName || !date) { sendJSON(res, 400, { error: 'Missing streamerName or date' }); return; }
    const updated = HighlightStore.update(streamerName, date, id, { startOffset, endOffset, duration: endOffset - startOffset });
    sendJSON(res, updated ? 200 : 404, updated || { error: 'Not found' });
    return;
  }

  if (url.pathname === '/api/highlights/clip' && req.method === 'POST') {
    const body = await parseJSON(req);
    const { ids, streamerName, date, filePath } = body;
    if (!ids || !ids.length || !streamerName || !date || !filePath) {
      sendJSON(res, 400, { error: 'Missing ids, streamerName, date, or filePath' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      sendJSON(res, 400, { error: 'Source video file not found: ' + filePath });
      return;
    }
    const data = HighlightStore.getAll(streamerName, date);
    const toClip = (data.highlights || []).filter(h => ids.includes(h.id));
    if (toClip.length === 0) {
      sendJSON(res, 400, { error: 'No matching highlights found' });
      return;
    }

    // Use largest recording file — avoids short restart fragments
    let mainFile = filePath;
    const fallbackFiles = [];
    try {
      const srcSize = fs.statSync(filePath).size;
      // Collect fallback files (valid, non-clip, sorted by size desc)
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
          logger.info(`[clip] Switching source to ${path.basename(mainFile)}`);
        }
      }
    } catch {}

    const results = [];
    const clipDir = path.dirname(filePath);

    for (const h of toClip) {
      const srcExt = path.extname(mainFile);
      const clipName = path.basename(mainFile, srcExt) + '_clip_' + Math.floor(h.startOffset) + 's_' + Math.floor(h.endOffset) + 's' + srcExt;
      const clipPath = path.join(clipDir, clipName);

      let clipped = false;
      // Try mainFile first, then fallbacks
      const filesToTry = [mainFile, ...fallbackFiles];
      for (const tryFile of filesToTry) {
        try {
          const tryExt = path.extname(tryFile);
          const tryClipName = path.basename(tryFile, tryExt) + '_clip_' + Math.floor(h.startOffset) + 's_' + Math.floor(h.endOffset) + 's' + tryExt;
          const tryClipPath = path.join(clipDir, tryClipName);
          await new Promise((resolve, reject) => {
            const args = [
              '-ss', String(h.startOffset),
              '-to', String(h.endOffset),
              '-i', tryFile,
              '-c', 'copy',
              '-avoid_negative_ts', 'make_zero',
              '-y', tryClipPath
            ];
            const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' });
            proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
            proc.on('error', reject);
          });

          HighlightStore.update(streamerName, date, h.id, { clipped: true, clipFile: tryClipPath });
          results.push({ id: h.id, ok: true, clipFile: tryClipPath });
          logger.info('[clip] ' + tryClipName + ' (' + Math.floor(h.startOffset) + 's-' + Math.floor(h.endOffset) + 's)' + (tryFile !== mainFile ? ' [fallback]' : ''));
          clipped = true;
          break;
        } catch (e) {
          if (tryFile === filesToTry[filesToTry.length - 1]) {
            results.push({ id: h.id, ok: false, error: e.message });
            logger.error('[clip] Failed: ' + h.id + ' — ' + e.message);
          }
        }
      }
      if (!clipped) continue;
    }

    sendJSON(res, 200, { results });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function migrateOrphanedDirs() {
  const savePath = Store.getSettings().savePath;
  const streamers = Store.getStreamers();
  try {
    const entries = fs.readdirSync(savePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      // Find a streamer whose roomId or old fallback patterns match this directory
      for (const s of streamers) {
        if (dirName === s.name) break; // already correct
        // Check if dirName is the room ID or "房间<roomId>" fallback
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

const PORT = process.env.PORT || 3456;
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
