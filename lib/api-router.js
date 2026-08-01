const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const logger = require('./logger');
const Store = require('./store');
const BiliAPI = require('./bili-api');
const { Recorder, FFMPEG_BIN, VIDEO_EXTS } = require('./recorder');
const { DanmakuManager } = require('./danmaku-manager');
const { Poller } = require('./poller');
const { HighlightStore } = require('./highlight-store');
const { autoClipAfterStream, clipHighlight, loadSegments, buildSources } = require('./clip');
const { finalizeStreamer, cleanupAllRecordings } = require('./lifecycle');
const { localDate, mergeDirContents, isPathInside } = require('./utils');

// ─── Internal helpers ───────────────────────────────────────────────────────

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

// CORS：页面由本服务同源提供，只允许本机来源跨域，防止恶意网页通过浏览器调用本地 API
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin };
  }
  return {};
}

function sendJSON(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// API 收到的 filePath 必须位于录制目录之内，防止任意路径删除/执行
function pathAllowed(filePath) {
  return isPathInside(Store.getSettings().savePath, filePath);
}

// 匹配 /api/streamer/:id/<suffix>，命中返回 id，否则 null
function streamerRouteId(pathname, suffix) {
  const prefix = '/api/streamer/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const mid = pathname.slice(prefix.length, pathname.length - suffix.length);
  return mid && !mid.includes('/') ? mid : null;
}

// 匹配 /api/streamer/:id（精确，无子路径），命中返回 id，否则 null
function streamerRouteExactId(pathname) {
  const match = pathname.match(/^\/api\/streamer\/([^/]+)$/);
  return match ? match[1] : null;
}

function getStreamer(id) {
  return Store.getStreamers().find(s => s.id === id);
}

function openWithSystemApp(filePath) {
  if (process.platform === 'win32') {
    const vlcPaths = [
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
    ];
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
}

// ─── Request handler ────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, data) => sendJSON(res, code, data, corsHeaders(req));

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Static files
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, '..', 'index.html'), 'text/html');
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
    send(200, { streamers, recordings, orphaned });
    return;
  }

  if (url.pathname === '/api/streamer' && req.method === 'POST') {
    const body = await parseJSON(req);
    const roomId = await BiliAPI.resolveRoomId(body.roomId);

    if (!roomId) {
      send(400, { error: '无法识别房间号，请输入纯数字房间号、live.bilibili.com 链接或 b23.tv 短链' });
      return;
    }
    if (Store.getStreamers().find(s => s.roomId === roomId)) {
      send(409, { error: 'Streamer already added' });
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
        try {
          const count = mergeDirContents(path.join(savePath, oldName), path.join(savePath, info.name));
          if (count > 0) logger.info(`[add] Merged orphaned dir ${oldName} -> ${info.name} (${count} files)`);
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
    } catch (e) {
      logger.warn(`[add] Failed to fetch room info for ${roomId}: ${e.message}`);
    }
    send(201, s);
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/start') && req.method === 'POST') {
    const id = streamerRouteId(url.pathname, '/start');
    if (Recorder.isRecording(id)) {
      send(400, { error: 'Already recording' });
      return;
    }
    const s = getStreamer(id);
    if (!s) { send(404, { error: 'Streamer not found' }); return; }
    const realRoomId = s.realRoomId || s.roomId;
    try {
      await Recorder.start(id, realRoomId, s.name);
      Store.updateStreamer(id, { recording: true, lastLiveTime: Date.now() });
      const s2 = getStreamer(id);
      if (s2 && !DanmakuManager.isRunning(id)) {
        DanmakuManager.start(id, s2.name, s2.realRoomId || s2.roomId);
      }
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/stop') && req.method === 'POST') {
    const id = streamerRouteId(url.pathname, '/stop');
    if (Recorder.isRecording(id)) {
      const stoppedFile = await Recorder.stop(id);
      await finalizeStreamer(id, stoppedFile);
      // gaveUpAt 抑制 poller 在 10min 退避期内自动重连——手动停止不应被立刻撤销
      Store.updateStreamer(id, { recording: false, gaveUpAt: Date.now() });
      send(200, { ok: true });

      // 手动停止录制也触发切片
      if (stoppedFile) {
        const s = getStreamer(id);
        if (s) await autoClipAfterStream(s.name, stoppedFile);
      }
    } else {
      send(400, { error: 'Not recording' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/quality') && req.method === 'PUT') {
    const id = streamerRouteId(url.pathname, '/quality');
    const body = await parseJSON(req);
    const quality = body.quality;
    if (!['auto', 'high', 'medium', 'low'].includes(quality)) {
      send(400, { error: 'Invalid quality. Use: auto, high, medium, low' });
      return;
    }
    const s = getStreamer(id);
    if (!s) { send(404, { error: 'Streamer not found' }); return; }
    s.quality = quality;
    Store.updateStreamer(id, { quality });
    send(200, { ok: true, quality });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/emotion-dict') && req.method === 'GET') {
    const id = streamerRouteId(url.pathname, '/emotion-dict');
    const s = getStreamer(id);
    if (!s) { send(404, { error: 'Streamer not found' }); return; }
    send(200, s.emotionDict || null);
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/emotion-dict') && req.method === 'PUT') {
    const id = streamerRouteId(url.pathname, '/emotion-dict');
    const s = getStreamer(id);
    if (!s) { send(404, { error: 'Streamer not found' }); return; }
    const body = await parseJSON(req);
    Store.updateStreamer(id, { emotionDict: body });
    send(200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/streamer/') && url.pathname.endsWith('/format') && req.method === 'PUT') {
    const id = streamerRouteId(url.pathname, '/format');
    const body = await parseJSON(req);
    const format = body.format;
    if (!['flv', 'mkv', 'ts', 'mp4'].includes(format)) {
      send(400, { error: 'Invalid format. Use: flv, mkv, ts, mp4' });
      return;
    }
    const s = getStreamer(id);
    if (!s) { send(404, { error: 'Streamer not found' }); return; }
    s.format = format;
    Store.updateStreamer(id, { format });
    send(200, { ok: true, format });
    return;
  }

  if (streamerRouteExactId(url.pathname) && req.method === 'DELETE') {
    const id = streamerRouteExactId(url.pathname);
    const deleteFiles = url.searchParams.get('deleteFiles') === 'true';
    const streamer = getStreamer(id);
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
    send(200, { ok: true });
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    send(200, Store.getSettings());
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await parseJSON(req);
    Store.updateSettings(body);
    send(200, Store.getSettings());
    return;
  }

  if (url.pathname === '/api/check' && req.method === 'POST') {
    Poller.check();
    send(200, { ok: true });
    return;
  }

  if (url.pathname === '/api/convert' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath || !fs.existsSync(filePath)) { send(400, { error: 'File not found' }); return; }
    if (!pathAllowed(filePath)) { send(403, { error: 'Path outside save directory' }); return; }
    if (Recorder.isWritingTo(filePath)) {
      send(409, { error: '文件正在录制中，请先停止再转换' });
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
      send(200, { ok: true, newPath });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/open-file' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath) { send(400, { error: 'Missing filePath' }); return; }
    if (!pathAllowed(filePath)) { send(403, { error: 'Path outside save directory' }); return; }
    try {
      openWithSystemApp(filePath);
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  // Open folder & select file in Explorer
  if (url.pathname === '/api/open-folder' && req.method === 'POST') {
    const body = await parseJSON(req);
    const filePath = body.filePath;
    if (!filePath) { send(400, { error: 'Missing filePath' }); return; }
    if (!pathAllowed(filePath)) { send(403, { error: 'Path outside save directory' }); return; }
    try {
      if (process.platform === 'win32') {
        execFile('explorer', ['/select,', filePath]);
      } else if (process.platform === 'darwin') {
        execFile('open', ['-R', filePath]);
      } else {
        execFile('xdg-open', [path.dirname(filePath)]);
      }
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/recording' && req.method === 'DELETE') {
    const filePath = url.searchParams.get('filePath');
    if (!filePath) { send(400, { error: 'Missing filePath' }); return; }
    if (!pathAllowed(filePath)) { send(403, { error: 'Path outside save directory' }); return; }
    // Check if any active recorder is writing to this file
    if (Recorder.isWritingTo(filePath)) {
      send(409, { error: '文件正在录制中，请先停止录制再删除' });
      return;
    }
    try {
      fs.unlinkSync(filePath);
      logger.info(`[recording] Deleted: ${filePath}`);
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    send(200, { ok: true });
    logger.info('Stopping all recordings by user request...');
    Poller.stop();

    try {
      await cleanupAllRecordings('shutdown');
    } catch (e) {
      logger.error(`[shutdown] Cleanup error: ${e.message}`);
    }

    // Reset all streamers to offline — server stays up, just idle
    for (const s of Store.getStreamers()) {
      Store.updateStreamer(s.id, { status: 'offline', recording: false });
    }
    logger.info('All recordings stopped. Server still running — close CMD window to exit.');
    return;
  }

  // ─── Full exit (cleanup + process.exit) ───────────────────────────────────

  if (url.pathname === '/api/exit' && req.method === 'POST') {
    send(200, { ok: true });
    logger.info('Server exiting by user request...');
    Poller.stop();

    const forceExit = setTimeout(() => { process.exit(0); }, 30000);

    try {
      await cleanupAllRecordings('exit');
    } catch (e) {
      logger.error(`[exit] Cleanup error: ${e.message}`);
    } finally {
      clearTimeout(forceExit);
      logger.info('Server exited. Close this window or press any key.');
      process.exit(0);
    }
    return;
  }

  // ─── Emotion Dictionary API ─────────────────────────────────────────────────

  if (url.pathname === '/api/emotion-dict' && req.method === 'GET') {
    send(200, Store.getEmotionDict());
    return;
  }

  if (url.pathname === '/api/emotion-dict' && req.method === 'PUT') {
    const body = await parseJSON(req);
    Store.setEmotionDict(body);
    send(200, { ok: true });
    return;
  }

  // ─── Highlight APIs ──────────────────────────────────────────────────────────

  if (url.pathname === '/api/highlights' && req.method === 'GET') {
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date') || localDate();
    if (!streamerName) { send(400, { error: 'Missing streamerName' }); return; }
    const data = HighlightStore.getAll(streamerName, date);
    const dates = HighlightStore.listDates(streamerName);
    send(200, { ...data, availableDates: dates });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    const streamerName = url.searchParams.get('streamerName');
    const date = url.searchParams.get('date');
    if (!streamerName || !date) { send(400, { error: 'Missing streamerName or date' }); return; }
    send(HighlightStore.remove(streamerName, date, id) ? 200 : 404, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/highlights/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    const body = await parseJSON(req);
    const { streamerName, date, startOffset, endOffset } = body;
    if (!streamerName || !date) { send(400, { error: 'Missing streamerName or date' }); return; }
    const updated = HighlightStore.update(streamerName, date, id, { startOffset, endOffset, duration: endOffset - startOffset });
    send(updated ? 200 : 404, updated || { error: 'Not found' });
    return;
  }

  if (url.pathname === '/api/highlights/clip' && req.method === 'POST') {
    const body = await parseJSON(req);
    const { ids, streamerName, date, filePath } = body;
    if (!ids || !ids.length || !streamerName || !date || !filePath) {
      send(400, { error: 'Missing ids, streamerName, date, or filePath' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      send(400, { error: 'Source video file not found: ' + filePath });
      return;
    }
    if (!pathAllowed(filePath)) { send(403, { error: 'Path outside save directory' }); return; }
    const data = HighlightStore.getAll(streamerName, date);
    const toClip = (data.highlights || []).filter(h => ids.includes(h.id));
    if (toClip.length === 0) {
      send(400, { error: 'No matching highlights found' });
      return;
    }

    const clipDir = path.dirname(filePath);
    const segments = loadSegments(clipDir);

    const results = [];
    for (const h of toClip) {
      const sources = buildSources(h, filePath, segments);
      try {
        const r = await clipHighlight({ streamerName, date, h, sources, clipDir });
        results.push({ id: h.id, ok: true, clipFile: r.clipFile });
        logger.info('[clip] ' + r.clipName + ' (' + Math.floor(h.startOffset) + 's-' + Math.floor(h.endOffset) + 's)' + (r.usedFallback ? ' [fallback]' : ''));
      } catch (e) {
        results.push({ id: h.id, ok: false, error: e.message });
        logger.error('[clip] Failed: ' + h.id + ' — ' + e.message);
      }
    }

    send(200, { results });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

module.exports = { handleRequest };
