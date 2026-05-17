const crypto = require('crypto');
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

// ─── WBI Signing ──────────────────────────────────────────────────────────────

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function getMixinKey(orig) {
  let result = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    if (idx < orig.length) result += orig[idx];
  }
  return result.slice(0, 32);
}

function signWbiParams(params, mixinKey) {
  const sorted = Object.keys(params).sort();
  const query = sorted.map(k => {
    const v = String(params[k]).replace(/[!'()*]/g, '');
    return k + '=' + encodeURIComponent(v);
  }).join('&');
  return crypto.createHash('md5').update(query + mixinKey).digest('hex');
}

let _cachedMixinKey = null;

async function fetchMixinKey() {
  if (_cachedMixinKey) return _cachedMixinKey;
  return new Promise((resolve) => {
    https.get('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://www.bilibili.com/' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const imgUrl = (j.data && j.data.wbi_img && j.data.wbi_img.img_url) || '';
          const subUrl = (j.data && j.data.wbi_img && j.data.wbi_img.sub_url) || '';
          const imgKey = imgUrl.split('/').pop().split('.')[0];
          const subKey = subUrl.split('/').pop().split('.')[0];
          _cachedMixinKey = getMixinKey(imgKey + subKey);
          resolve(_cachedMixinKey);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function clearMixinKey() { _cachedMixinKey = null; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function biliGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://www.bilibili.com/' } }, (res) => {
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
 * Returns a Buffer (or null on failure).
 */
function decompressBody(protoVer, body, logger) {
  if (!body || body.length === 0) return null;
  try {
    if (protoVer === PROTO_BROTLI) return zlib.brotliDecompressSync(body);
    if (protoVer === PROTO_ZLIB) return zlib.inflateSync(body);
    return body;
  } catch (e) {
    if (logger) logger.warn(`DanmakuParser: decompress failed proto=${protoVer}: ${e.message}`);
    return null;
  }
}

/**
 * B站 v3 brotli payload contains nested packets: each sub-message has a 16-byte header
 * followed by a JSON body. Parse the decompressed buffer into individual JSON messages.
 */
function parseNestedPackets(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN) return [];
  const messages = [];
  let offset = 0;
  while (offset + HEADER_LEN <= buf.length) {
    const totalLen = buf.readUInt32BE(offset);
    if (totalLen < HEADER_LEN || offset + totalLen > buf.length) break;
    const bodyLen = totalLen - HEADER_LEN;
    if (bodyLen > 0) {
      const body = buf.slice(offset + HEADER_LEN, offset + totalLen);
      try { messages.push(JSON.parse(body.toString('utf-8'))); } catch {}
    }
    offset += totalLen;
  }
  return messages;
}

/**
 * Legacy: split concatenated JSON objects on `}{` boundaries.
 * Used for protoVer 0 (plain JSON) messages.
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

  // ── Protobuf helper for INTERACT_WORD_V2 ──────────────────────────────

  function decodePbStrings(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2) return [];
    const strings = [];
    let offset = 0;
    while (offset < buf.length - 1) {
      const tagByte = buf[offset];
      const wireType = tagByte & 0x07;
      const fieldNum = tagByte >>> 3;
      offset++;
      if (wireType === 0) {
        // Varint
        while (offset < buf.length && (buf[offset] & 0x80)) offset++;
        offset++;
      } else if (wireType === 2) {
        // Length-delimited
        let len = 0, shift = 0;
        while (offset < buf.length) {
          const b = buf[offset++];
          len |= (b & 0x7f) << shift;
          shift += 7;
          if (!(b & 0x80)) break;
        }
        if (offset + len <= buf.length) {
          strings.push({ fieldNum, val: buf.slice(offset, offset + len).toString('utf-8') });
          offset += len;
        } else {
          break;
        }
      } else if (wireType === 1 || wireType === 5) {
        offset += wireType === 1 ? 8 : 4;
      } else {
        break;
      }
    }
    return strings;
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

        case 'INTERACT_WORD_V2': {
          const d = msg.data || {};
          if (d.pb) {
            const pbBuf = Buffer.from(d.pb, 'base64');
            const strings = decodePbStrings(pbBuf);
            // Pick longest non-URL string as danmaku text
            const candidates = strings.filter(s => s.val && !/^https?:\/\//i.test(s.val));
            candidates.sort((a, b) => b.val.length - a.val.length);
            const text = candidates.length > 0 ? candidates[0].val : '';
            if (text && stats.danmakuCount < 5 && logger) {
              logger.info(`DanmakuParser: INTERACT_WORD_V2 text="${text}" candidates=${candidates.length}`);
            }
            const danmaku = {
              text,
              uid: 0,
              uname: '',
              timestamp: Date.now(),
              raw: msg
            };
            stats.danmakuCount++;
            emit('danmaku', danmaku);
          }
          break;
        }

        case 'LIKE_INFO_V3_CLICK': {
          const d = msg.data || {};
          const danmaku = {
            text: d.like_text || '点赞',
            uid: d.uid || 0,
            uname: d.uname || '',
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
          // Log new/unknown message types for debugging (first 3 of each cmd)
          if (msg.cmd) {
            stats._unknownCmds = stats._unknownCmds || {};
            stats._unknownCmds[msg.cmd] = (stats._unknownCmds[msg.cmd] || 0) + 1;
            if (stats._unknownCmds[msg.cmd] <= 3) {
              if (logger) logger.info(`DanmakuParser: unknown cmd=${msg.cmd} keys=${JSON.stringify(Object.keys(msg)).slice(0,120)} dataKeys=${JSON.stringify(Object.keys(msg.data || {})).slice(0,200)}`);
            }
          }
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

    const buf = decompressBody(packet.protoVer, packet.body, logger);
    if (!buf) return;

    // Compressed payloads (proto 2/3) use nested binary packet structure
    // Proto 0 uses plain concatenated JSON
    const messages = (packet.protoVer === PROTO_ZLIB || packet.protoVer === PROTO_BROTLI)
      ? parseNestedPackets(buf)
      : parseMessages(buf.toString('utf-8'));

    for (const msg of messages) {
      handleMessage(msg);
    }

    // Log non-empty messages periodically (first 3, then every 100th)
    if (messages.length > 0) {
      stats._msgCount = (stats._msgCount || 0) + messages.length;
      stats._batchCount = (stats._batchCount || 0) + 1;
      if (stats._batchCount <= 3 || stats._batchCount % 100 === 0) {
        const cmds = [...new Set(messages.map(m => m.cmd || 'unknown'))];
        if (logger) logger.info(`DanmakuParser: batch#${stats._batchCount} ${messages.length} msgs, cmds: ${cmds.join(',')}`);
      }
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

      // Step 1: Fetch danmaku auth token from B站 API (with WBI signing)
      const mixinKey = await fetchMixinKey();
      const baseUrl = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo`;
      const wts = Math.floor(Date.now() / 1000);
      const params = { id: roomId, type: 0, wts };
      if (mixinKey) {
        params.w_rid = signWbiParams(params, mixinKey);
      }
      const apiUrl = baseUrl + '?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
      if (logger) logger.info(`DanmakuParser: fetching danmaku token for room ${roomId}`);
      const res = await biliGet(apiUrl);
      if (res.code !== 0) {
        if (res.code === -352 && mixinKey) {
          clearMixinKey();
        }
        throw new Error(`B站 danmaku API error: ${res.message || 'unknown'} (code=${res.code})`);
      }

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
