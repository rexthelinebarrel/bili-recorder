// test-danmaku-rest.js — 测试 B站 REST 弹幕历史 API
const https = require('https');
const crypto = require('crypto');

const ROOM_ID = '31001522';

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
          const imgUrl = (j.data?.wbi_img?.img_url) || '';
          const subUrl = (j.data?.wbi_img?.sub_url) || '';
          const imgKey = imgUrl.split('/').pop().split('.')[0];
          const subKey = subUrl.split('/').pop().split('.')[0];
          resolve(getMixinKey(imgKey + subKey));
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function apiGet(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://live.bilibili.com/' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { console.error('Parse err:', e.message); resolve(null); }
      });
    }).on('error', (e) => { console.error('Fetch err:', e.message); resolve(null); });
  });
}

async function main() {
  console.log('=== 测试 B站 弹幕历史 REST API ===\n');

  // Test 1: Without WBI signing
  console.log('1. 无 WBI 签名:');
  let res = await apiGet(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${ROOM_ID}&room_type=0`);
  if (res) {
    console.log(`   code=${res.code} message="${res.message}" rooms=${res.data?.room?.length || 0} admin=${res.data?.admin?.length || 0}`);
  }

  // Test 2: With WBI signing
  console.log('\n2. 有 WBI 签名:');
  const mixinKey = await fetchMixinKey();
  console.log(`   mixinKey: ${mixinKey?.slice(0,8) || 'NULL'}...`);
  const wts = Math.floor(Date.now() / 1000);
  const params = { roomid: ROOM_ID, room_type: 0, wts };
  if (mixinKey) params.w_rid = signWbiParams(params, mixinKey);
  const signedUrl = 'https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?' +
    Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  res = await apiGet(signedUrl);
  if (res) {
    console.log(`   code=${res.code} message="${res.message}"`);
    const roomMsgs = res.data?.room || [];
    const adminMsgs = res.data?.admin || [];
    console.log(`   room messages: ${roomMsgs.length}, admin messages: ${adminMsgs.length}`);
    for (const m of roomMsgs.slice(0, 3)) {
      console.log(`   - user="${m.nickname}" text="${m.text}" timeline="${m.timeline}"`);
    }
  }

  // Test 3: Different endpoint - room/v1/Room/room_entry_action
  console.log('\n3. 房间入口动作 API:');
  res = await apiGet(`https://api.live.bilibili.com/xlive/web-room/v1/dM/roomEntryAction?roomid=${ROOM_ID}`);
  if (res) {
    console.log(`   code=${res.code} message="${res.message}" events=${res.data?.length || 0}`);
  }

  // Test 4: Try the old danmaku endpoint for live
  console.log('\n4. 旧版弹幕段 API (seg.so):');
  res = await apiGet(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${ROOM_ID}`);
  if (res) {
    // Try without room_type
    const roomMsgs = res.data?.room || [];
    console.log(`   code=${res.code} messages=${roomMsgs.length}`);
    if (roomMsgs.length > 0) {
      console.log('   SAMPLE:');
      const sample = roomMsgs[0];
      console.log(`   ${JSON.stringify(sample, null, 2).slice(0, 400)}`);
    }
  }

  console.log('\n=== 测试完成 ===');
}

main().catch(e => console.error(e));
