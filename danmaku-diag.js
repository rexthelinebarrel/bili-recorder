// danmaku-diag.js — 诊断 danmaku WebSocket 连接状态
const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');

const ROOM_ID = '31001522';
const logger = {
  info: (m) => console.log(`[INFO] ${new Date().toISOString().slice(11,19)} ${m}`),
  warn: (m) => console.log(`[WARN] ${new Date().toISOString().slice(11,19)} ${m}`),
  error: (m) => console.log(`[ERROR] ${new Date().toISOString().slice(11,19)} ${m}`)
};

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function getMixinKey(orig) {
  let result = '';
  for (const idx of MIXIN_KEY_ENC_TAB) if (idx < orig.length) result += orig[idx];
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

async function fetchMixinKey() {
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
          resolve(getMixinKey(imgKey + subKey));
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function biliGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://www.bilibili.com/' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse failed')); }
      });
    }).on('error', reject);
  });
}

const OP_HEARTBEAT_REPLY = 3;
const OP_SERVER_MSG = 5;
const HEADER_LEN = 16;

function unpackPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_LEN) return null;
  return {
    totalLen: buffer.readUInt32BE(0),
    headerLen: buffer.readUInt16BE(4),
    protoVer: buffer.readUInt16BE(6),
    op: buffer.readUInt32BE(8),
    seq: buffer.readUInt32BE(12),
    body: buffer.length > HEADER_LEN ? buffer.slice(HEADER_LEN) : Buffer.alloc(0)
  };
}

async function main() {
  logger.info('=== Danmaku 诊断开始 ===');

  // Step 1: Fetch danmaku token
  logger.info('获取 WBI mixin key...');
  const mixinKey = await fetchMixinKey();
  logger.info(`Mixin key: ${mixinKey ? mixinKey.slice(0, 8) + '...' : 'NULL (WBI unavailable)'}`);

  const wts = Math.floor(Date.now() / 1000);
  const params = { id: ROOM_ID, type: 0, wts };
  if (mixinKey) params.w_rid = signWbiParams(params, mixinKey);
  const apiUrl = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' +
    Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');

  logger.info('获取 danmaku token...');
  let res;
  try {
    res = await biliGet(apiUrl);
    logger.info(`API response code: ${res.code} message: ${res.message || '-'}`);
  } catch (e) {
    logger.error(`API 请求失败: ${e.message}`);
    process.exit(1);
  }

  if (res.code !== 0) {
    logger.error(`API 返回错误码 ${res.code}: ${res.message}`);
    process.exit(1);
  }

  const token = res.data.token;
  const hostInfo = res.data.host_list[0];
  logger.info(`Token: ${token ? token.slice(0, 20) + '...' : 'MISSING'}`);
  logger.info(`Host: ${hostInfo.host}:${hostInfo.wss_port}`);

  // Step 2: Connect WebSocket
  const wsUrl = `wss://${hostInfo.host}:${hostInfo.wss_port}/sub`;
  logger.info(`连接 WebSocket: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  let msgCount = 0;
  let protoStats = {};

  ws.on('open', () => {
    logger.info('WebSocket 已连接, 发送认证...');
    const authBody = JSON.stringify({
      uid: 0, roomid: Number(ROOM_ID), protover: 3, platform: 'web', type: 2, key: token
    });
    const bodyBuf = Buffer.from(authBody, 'utf-8');
    const buf = Buffer.alloc(HEADER_LEN + bodyBuf.length);
    buf.writeUInt32BE(HEADER_LEN + bodyBuf.length, 0);
    buf.writeUInt16BE(HEADER_LEN, 4);
    buf.writeUInt16BE(0, 6); // PROTO_JSON
    buf.writeUInt32BE(7, 8); // OP_AUTH_JOIN
    buf.writeUInt32BE(1, 12);
    bodyBuf.copy(buf, HEADER_LEN);
    ws.send(buf);
  });

  ws.on('message', (data) => {
    msgCount++;
    const pkt = unpackPacket(data);
    if (!pkt) { logger.warn(`msg#${msgCount}: 无法解析`); return; }

    const opName = {
      3: 'HEARTBEAT_REPLY', 5: 'SERVER_MSG', 8: 'AUTH_REPLY'
    }[pkt.op] || `UNKNOWN(${pkt.op})`;

    if (pkt.op === OP_HEARTBEAT_REPLY) {
      if (msgCount <= 3) logger.info(`msg#${msgCount}: ${opName} (proto=${pkt.protoVer})`);
      return;
    }

    // Track proto stats
    protoStats[pkt.protoVer] = (protoStats[pkt.protoVer] || 0) + 1;

    if (msgCount <= 5) {
      logger.info(`msg#${msgCount}: ${opName} proto=${pkt.protoVer} bodyLen=${pkt.body.length}`);
    }

    // Decode body
    let text = '';
    try {
      const zlib = require('zlib');
      if (pkt.protoVer === 3) {
        text = zlib.brotliDecompressSync(pkt.body).toString('utf-8');
      } else if (pkt.protoVer === 2) {
        text = zlib.inflateSync(pkt.body).toString('utf-8');
      } else {
        text = pkt.body.toString('utf-8');
      }

      // Parse messages
      const messages = text.split(/}(?=\{|$)/).filter(Boolean).map(p => {
        try { return JSON.parse(p + '}'); } catch { return null; }
      }).filter(Boolean);

      if (msgCount <= 5) {
        logger.info(`  解析到 ${messages.length} 条消息`);
        for (const m of messages.slice(0, 3)) {
          logger.info(`  cmd=${m.cmd} keys=${Object.keys(m).slice(0,4).join(',')}`);
        }
      }

      // Count by cmd
      for (const m of messages) {
        const cmd = m.cmd || 'unknown';
        protoStats[cmd] = (protoStats[cmd] || 0) + 1;
      }
    } catch (e) {
      logger.warn(`msg#${msgCount}: 解压/解析失败 proto=${pkt.protoVer}: ${e.message}`);
      if (msgCount <= 3) {
        logger.warn(`  body 前16字节: ${pkt.body.slice(0, 16).toString('hex')}`);
      }
    }
  });

  ws.on('close', (code) => {
    logger.info(`WebSocket 关闭 code=${code}`);
    logger.info(`共收到 ${msgCount} 条消息`);
    logger.info(`Proto 统计: ${JSON.stringify(protoStats)}`);
    process.exit(0);
  });

  ws.on('error', (err) => {
    logger.error(`WebSocket 错误: ${err.message}`);
  });

  // Collect for 60 seconds
  setTimeout(() => {
    logger.info('--- 60秒诊断结果 ---');
    logger.info(`总消息数: ${msgCount}`);
    logger.info(`协议版本分布: ${JSON.stringify(protoStats)}`);
    ws.close();
  }, 60000);
}

main().catch(e => { logger.error(e.message); process.exit(1); });
