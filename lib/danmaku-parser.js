const WebSocket = require('ws');
const https = require('https');
const zlib = require('zlib');

// ─── Protocol Constants ───────────────────────────────────────────────────────

const OP_HEARTBEAT = 2;
const OP_HEARTBEAT_REPLY = 3;
const OP_SERVER_MSG = 5;
const OP_AUTH_JOIN = 7;
const OP_AUTH_REPLY = 8;

const PROTO_JSON = 0;
const PROTO_ZLIB = 2;
const PROTO_BROTLI = 3;

const HEADER_LEN = 16;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function biliGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Read a binary B站 protocol packet.
 * Returns { totalLen, headerLen, protoVer, op, seq, body } or null if too short.
 */
function unpackPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_LEN) return null;
  const totalLen = buffer.readUInt32BE(0);
  const headerLen = buffer.readUInt16BE(4);
  const protoVer = buffer.readUInt16BE(6);
  const op = buffer.readUInt32BE(8);
  const seq = buffer.readUInt32BE(12);
  const bodyLen = totalLen > headerLen ? totalLen - headerLen : 0;
  const body = bodyLen > 0 ? buffer.slice(headerLen, headerLen + bodyLen) : Buffer.alloc(0);
  return { totalLen, headerLen, protoVer, op, seq, body };
}

/**
 * Decompress the body according to protocol version.
 * protoVer 0 = plain JSON, 2 = zlib deflate, 3 = brotli.
 */
function decompressBody(protoVer, body) {
  if (!body || body.length === 0) return '';
  try {
    if (protoVer === PROTO_BROTLI) return zlib.brotliDecompressSync(body).toString('utf-8');
    if (protoVer === PROTO_ZLIB) return zlib.inflateSync(body).toString('utf-8');
    return body.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * B站 sends multiple concatenated JSON objects in a single message.
 * Split on `}` followed by `{` or end-of-string, then re-add the closing brace.
 */
function parseMessages(text) {
  if (!text) return [];
  const messages = [];
  const parts = text.split(/}(?=\{|$)/).filter(Boolean);
  for (const part of parts) {
    try { messages.push(JSON.parse(part + '}')); } catch {}
  }
  return messages;
}

/**
 * Build a binary B站 protocol packet.
 * @param {number} op - Operation code
 * @param {Buffer|string} body - Packet body (Buffer or string)
 */
function packBuffer(op, body) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8');
  const totalLen = HEADER_LEN + bodyBuf.length;
  const buf = Buffer.alloc(totalLen);
  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(HEADER_LEN, 4);
  buf.writeUInt16BE(PROTO_JSON, 6);
  buf.writeUInt32BE(op, 8);
  buf.writeUInt32BE(1, 12);
  bodyBuf.copy(buf, HEADER_LEN);
  return buf;
}

/**
 * Create the auth-join packet (op=7) for room authentication.
 */
function packAuth(roomId, token) {
  const body = JSON.stringify({
    uid: 0,
    roomid: Number(roomId),
    protover: 3,
    platform: 'web',
    type: 2,
    key: token
  });
  return packBuffer(OP_AUTH_JOIN, body);
}

/**
 * Create the heartbeat packet (op=2). Empty 16-byte header, no body.
 */
function packHeartbeat() {
  const buf = Buffer.alloc(HEADER_LEN);
  buf.writeUInt32BE(HEADER_LEN, 0);
  buf.writeUInt16BE(HEADER_LEN, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(OP_HEARTBEAT, 8);
  buf.writeUInt32BE(1, 12);
  return buf;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createDanmakuParser(roomId, logger) {
  let ws = null;
  let heartbeatTimer = null;
  let connected = false;

  const handlers = {
    danmaku: [],
    gift: [],
    guard: [],
    close: [],
    error: [],
    raw: []
  };

  const stats = {
    danmakuCount: 0,
    giftTotalValue: 0,
    startTime: null,
    roomId
  };

  // ── Internal helpers ──────────────────────────────────────────────────────

  function emit(event, data) {
    for (const fn of handlers[event] || []) {
      try { fn(data); } catch (e) {
        if (logger) logger.warn(`DanmakuParser ${event} handler error: ${e.message}`);
      }
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(packHeartbeat()); } catch {}
      }
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function handleMessage(msg) {
    try {
      switch (msg.cmd) {
        case 'DANMU_MSG': {
          const info = Array.isArray(msg.info) ? msg.info : [];
          const user = Array.isArray(info[2]) ? info[2] : [];
          const danmaku = {
            text: info[1] || '',
            uid: user[0] || 0,
            uname: user[1] || '',
            timestamp: Date.now(),
            raw: msg
          };
          stats.danmakuCount++;
          emit('danmaku', danmaku);
          break;
        }

        case 'SEND_GIFT': {
          const d = msg.data || {};
          const totalCoin = (d.price || 0) * (d.num || 0);
          const gift = {
            giftName: d.giftName || '',
            price: d.price || 0,
            num: d.num || 0,
            totalCoin,
            rmb: totalCoin / 1000,
            uid: d.uid || 0,
            uname: d.uname || '',
            timestamp: Date.now(),
            raw: msg
          };
          stats.giftTotalValue += totalCoin;
          emit('gift', gift);
          break;
        }

        case 'GUARD_BUY': {
          const d = msg.data || {};
          const guardLevel = d.guard_level || 0;
          const guardNameMap = { 1: '总督', 2: '提督', 3: '舰长' };
          const rmbMap = { 1: 19998, 2: 1998, 3: 198 };
          const guard = {
            guardLevel,
            guardName: d.gift_name || guardNameMap[guardLevel] || '',
            rmb: d.price ? d.price / 10 : (rmbMap[guardLevel] || 0),
            uid: d.uid || 0,
            uname: d.username || '',
            timestamp: Date.now(),
            raw: msg
          };
          emit('guard', guard);
          break;
        }

        default:
          emit('raw', msg);
          break;
      }
    } catch (e) {
      if (logger) logger.warn(`DanmakuParser message handling error: ${e.message}`);
    }
  }

  function handleBinary(data) {
    const packet = unpackPacket(data);
    if (!packet) return;

    // Ignore heartbeat replies — no body to decode
    if (packet.op === OP_HEARTBEAT_REPLY) return;

    const text = decompressBody(packet.protoVer, packet.body);
    if (!text) return;

    const messages = parseMessages(text);
    for (const msg of messages) {
      handleMessage(msg);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    stats,

    on(event, fn) {
      if (handlers[event]) handlers[event].push(fn);
      return this;
    },

    async start() {
      if (connected) return;

      // Step 1: Fetch danmaku auth token from B站 API
      const apiUrl = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=0`;
      if (logger) logger.info(`DanmakuParser: fetching danmaku token for room ${roomId}`);
      const res = await biliGet(apiUrl);
      if (res.code !== 0) throw new Error(`B站 danmaku API error: ${res.message || 'unknown'}`);

      const token = (res.data || {}).token;
      const hostInfo = ((res.data || {}).host_list || [])[0];
      if (!token) throw new Error('No danmaku token received');
      if (!hostInfo) throw new Error('No danmaku host received');

      // Step 2: Connect WebSocket to danmaku server
      const wsUrl = `wss://${hostInfo.host}:${hostInfo.wss_port}/sub`;
      if (logger) logger.info(`DanmakuParser: connecting to ${wsUrl}`);

      ws = new WebSocket(wsUrl);

      // Step 3: Wait for connection + auth handshake
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error('WebSocket auth timeout (10s)')); }
        }, 10000);

        ws.on('open', () => {
          if (settled) return;
          if (logger) logger.info('DanmakuParser: WebSocket open, sending auth');
          try { ws.send(packAuth(roomId, token)); } catch (e) { reject(e); }
        });

        ws.on('message', (data) => {
          if (settled) return;
          if (!Buffer.isBuffer(data) || data.length < HEADER_LEN) return;

          const op = data.readUInt32BE(8);
          if (op === OP_AUTH_REPLY) {
            settled = true;
            clearTimeout(timeout);
            if (logger) logger.info('DanmakuParser: auth success (op=8)');
            ws.removeAllListeners('message');
            ws.on('message', handleBinary);
            connected = true;
            stats.startTime = Date.now();
            startHeartbeat();
            resolve();
          }
        });

        ws.on('error', (err) => {
          emit('error', { message: err.message });
          if (!settled) { settled = true; clearTimeout(timeout); reject(err); }
        });

        ws.on('close', (code) => {
          connected = false;
          stopHeartbeat();
          stats.startTime = null;
          emit('close', { code });
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`WebSocket closed before auth (code=${code})`));
          }
          if (logger) logger.info(`DanmakuParser: WebSocket closed (code=${code})`);
        });
      });
    },

    stop() {
      connected = false;
      stopHeartbeat();
      stats.startTime = null;
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
      if (logger) logger.info('DanmakuParser: stopped');
    }
  };
}

module.exports = { createDanmakuParser, biliGet, packAuth };
