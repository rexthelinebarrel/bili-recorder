// auto-clip.js — 自动切片脚本
// 等待指定秒数后，停止录制 → 获取高光 → 自动剪辑
const http = require('http');

const WAIT_SEC = isNaN(parseInt(process.argv[2])) ? 7200 : parseInt(process.argv[2]);
const STREAMER_ID = process.argv[3] || '1778749091207';
const TOP_N = parseInt(process.argv[4]) || 5;
const BASE = 'http://localhost:3456';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log(`[auto-clip] 等待 ${WAIT_SEC}s 后开始切片...`);
  await new Promise(r => setTimeout(r, WAIT_SEC * 1000));

  // 1. 获取当前状态和文件路径
  console.log('[auto-clip] 获取录制状态...');
  const status = await api('GET', '/api/status');
  const streamer = (status.streamers || []).find(s => s.id === STREAMER_ID);
  if (!streamer) {
    console.error('[auto-clip] 未找到主播:', STREAMER_ID);
    process.exit(1);
  }
  const filePath = streamer.lastFilePath;
  const streamerName = streamer.name;
  console.log('[auto-clip] 主播:', streamerName, '文件:', filePath);

  // 2. 如果正在录制，先停止
  if (streamer.recording) {
    console.log('[auto-clip] 停止录制...');
    await api('POST', `/api/streamer/${STREAMER_ID}/stop`);
    console.log('[auto-clip] 录制已停止，等待音频分析...');
    await new Promise(r => setTimeout(r, 15000)); // 等音频分析完成
  }

  // 3. 获取高光数据
  const date = new Date().toISOString().slice(0, 10);
  const encodedName = encodeURIComponent(streamerName);
  console.log(`[auto-clip] 获取高光: ${streamerName} ${date}`);
  const highlightData = await api('GET', `/api/highlights?streamerName=${encodedName}&date=${date}`);

  const highlights = (highlightData.highlights || [])
    .filter(h => !h.clipped)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  console.log(`[auto-clip] 共 ${(highlightData.highlights || []).length} 个高光，选出 ${highlights.length} 个待剪辑`);
  if (highlights.length === 0) {
    console.log('[auto-clip] 无待剪辑高光，结束');
    process.exit(0);
  }

  for (const h of highlights) {
    console.log(`  #${h.id} score=${h.score} ${h.title || ''} [${h.startOffset}s-${h.endOffset}s]`);
  }

  // 4. 执行剪辑
  console.log('[auto-clip] 开始切片...');
  const ids = highlights.map(h => h.id);
  const clipResult = await api('POST', '/api/highlights/clip', {
    ids,
    streamerName,
    date,
    filePath
  });

  console.log('[auto-clip] 切片结果:', JSON.stringify(clipResult, null, 2));
  console.log('[auto-clip] 完成!');
}

main().catch(e => {
  console.error('[auto-clip] 错误:', e.message);
  process.exit(1);
});
