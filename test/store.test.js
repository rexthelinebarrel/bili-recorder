const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require store 之前注入配置路径，否则单例会读到真实 config.json
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-store-'));
const CONFIG = path.join(tmpDir, 'config.json');
process.env.BILI_RECORDER_CONFIG = CONFIG;

const Store = require('../lib/store');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('first load creates defaults with emotionDict', () => {
  assert.deepStrictEqual(Store.getStreamers(), []);
  assert.strictEqual(Store.getSettings().format, 'flv');
  assert.ok(Array.isArray(Store.getEmotionDict().laugh));
  assert.ok(fs.existsSync(CONFIG));
});

test('save is atomic — no leftover .tmp file', () => {
  Store.updateSettings({ format: 'mkv' });
  assert.strictEqual(fs.existsSync(CONFIG + '.tmp'), false);
  const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
  assert.strictEqual(onDisk.settings.format, 'mkv');
});

test('corrupt config is backed up, not overwritten silently', () => {
  fs.writeFileSync(CONFIG, '{not valid json', 'utf-8');
  Store._data = null;
  Store.load();
  // 备份保留了原始损坏内容
  assert.strictEqual(fs.readFileSync(CONFIG + '.bak', 'utf-8'), '{not valid json');
  // 回退到默认配置
  assert.deepStrictEqual(Store.getStreamers(), []);
  // load 后 save 会写入新配置，但 .bak 仍可人工找回
});

test('setEmotionDict persists', () => {
  Store.setEmotionDict({ custom: ['x'] });
  const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
  assert.deepStrictEqual(onDisk.emotionDict, { custom: ['x'] });
});
