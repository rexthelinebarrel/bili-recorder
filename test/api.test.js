const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 注入临时配置，避免动到真实 config.json；savePath 也指向临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-api-'));
process.env.BILI_RECORDER_CONFIG = path.join(tmpDir, 'config.json');

const Store = require('../lib/store');
const { handleRequest } = require('../lib/api-router');

const recordingsDir = path.join(tmpDir, 'recordings');
fs.mkdirSync(recordingsDir, { recursive: true });
Store.updateSettings({ savePath: recordingsDir });

let server;
let base;

test.before(async () => {
  server = http.createServer(handleRequest);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /api/settings returns settings', async () => {
  const res = await fetch(base + '/api/settings');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.savePath, recordingsDir);
});

test('GET /api/status returns streamers/recordings/orphaned', async () => {
  const res = await fetch(base + '/api/status');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.streamers, []);
  assert.deepStrictEqual(body.recordings, []);
});

test('CORS: localhost origin is allowed, foreign origin is not', async () => {
  const local = await fetch(base + '/api/status', { headers: { Origin: 'http://localhost:3456' } });
  assert.strictEqual(local.headers.get('access-control-allow-origin'), 'http://localhost:3456');

  const evil = await fetch(base + '/api/status', { headers: { Origin: 'http://evil.example.com' } });
  assert.strictEqual(evil.headers.get('access-control-allow-origin'), null);
});

test('DELETE /api/recording rejects path outside save dir', async () => {
  const outside = path.join(os.tmpdir(), 'definitely-not-in-savedir.txt');
  const res = await fetch(base + '/api/recording?filePath=' + encodeURIComponent(outside), { method: 'DELETE' });
  assert.strictEqual(res.status, 403);
});

test('POST /api/open-file rejects path outside save dir', async () => {
  const res = await fetch(base + '/api/open-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: 'C:\\Windows\\System32\\cmd.exe' })
  });
  assert.strictEqual(res.status, 403);
});

test('POST /api/streamer rejects unrecognizable room id', async () => {
  const res = await fetch(base + '/api/streamer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: 'not a room at all' })
  });
  assert.strictEqual(res.status, 400);
});

test('GET /api/emotion-dict returns default dict', async () => {
  const res = await fetch(base + '/api/emotion-dict');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.laugh));
});

test('unknown route returns 404', async () => {
  const res = await fetch(base + '/api/nope');
  assert.strictEqual(res.status, 404);
});
