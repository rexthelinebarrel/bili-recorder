const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILI_RECORDER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-cfg-')), 'config.json');

const { createHighlightEngine } = require('../lib/highlight-engine');

const nullLogger = { info() {}, warn() {}, error() {} };

test('engine without recording start: feeds are safe, stats are zeroed', () => {
  const engine = createHighlightEngine('t1', '__test__', '123', nullLogger, null);
  engine.feedDanmaku('666', 'u1');
  engine.feedDanmaku('哈哈', 'u2');
  engine.feedGift(100);
  const stats = engine.getStats();
  assert.strictEqual(stats.danmaku5s, 2);
  assert.strictEqual(stats.gift10s, 100);
  assert.strictEqual(stats.lastHighlightTime, null);
});

test('danmaku within same second bucket are aggregated', () => {
  const engine = createHighlightEngine('t2', '__test__', '123', nullLogger, null);
  for (let i = 0; i < 5; i++) engine.feedDanmaku('来了来了', 'u' + i);
  const stats = engine.getStats();
  assert.strictEqual(stats.danmaku5s, 5);
  assert.strictEqual(stats.danmaku60s, 5);
  // 关键词命中（"来了来了" 在 KEYWORD_PATTERNS 里）
  assert.strictEqual(stats.keyword5s, 5);
});

test('cooldown period: no highlight committed in first 3 minutes', () => {
  const engine = createHighlightEngine('t3', '__test__', '123', nullLogger, null);
  engine.setRecordingStart(Date.now() / 1000);
  // 大量弹幕也不会在冷却期内触发（offset < 180s）
  for (let i = 0; i < 50; i++) engine.feedDanmaku('高能', 'u' + i);
  const stats = engine.getStats();
  assert.strictEqual(stats.lastHighlightTime, null);
});
