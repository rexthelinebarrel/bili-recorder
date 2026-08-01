const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILI_RECORDER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-cfg-')), 'config.json');

const { createHighlightEngine } = require('../lib/highlight-engine');
const { HighlightStore } = require('../lib/highlight-store');
const { localDate } = require('../lib/utils');

const nullLogger = { info() {}, warn() {}, error() {} };
const RECORDINGS = path.join(__dirname, '..', 'recordings');

// 高光会写入 recordings/<name>/，测试用的名字统一清理
const TEST_NAMES = ['__test_commit__', '__test_attach__'];

test.after(() => {
  for (const n of TEST_NAMES) {
    fs.rmSync(path.join(RECORDINGS, n), { recursive: true, force: true });
  }
});

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
  // 关键词命中（"来了来了" 在内置 DEFAULT_KEYWORD_PATTERNS 里）
  assert.strictEqual(stats.keyword5s, 5);
});

test('cooldown period: no highlight committed in first 3 minutes', () => {
  const engine = createHighlightEngine('t3', '__test__', '123', nullLogger, null);
  engine.setRecordingStart(Date.now() / 1000);
  for (let i = 0; i < 50; i++) engine.feedDanmaku('高能', 'u' + i);
  assert.strictEqual(engine.getStats().lastHighlightTime, null);
});

// ─── v3: 冷启动基线门控 ───

test('cold start: thin baseline keeps sparse activity below threshold', () => {
  const engine = createHighlightEngine('t4', '__test__', '123', nullLogger, null);
  engine.setRecordingStart(Date.now() / 1000 - 200); // 跳过冷却期
  // 3 条稀疏弹幕：旧版 z 虚高能过阈值，v3 基线样本不足 z 不参与
  for (let i = 0; i < 3; i++) engine.feedDanmaku('你好', 'u' + i);
  assert.strictEqual(engine.getStats().lastHighlightTime, null);
});

// ─── v3: 强共识正常触发 ───

test('strong consensus commits a highlight', () => {
  const engine = createHighlightEngine('t5', '__test_commit__', '123', nullLogger, { praise: ['666'] });
  engine.setRecordingStart(Date.now() / 1000 - 200);
  for (let i = 0; i < 12; i++) engine.feedDanmaku('666', 'u' + i);
  assert.notStrictEqual(engine.getStats().lastHighlightTime, null);

  const data = HighlightStore.getAll('__test_commit__', localDate());
  assert.strictEqual(data.highlights.length, 1);
  assert.ok(data.highlights[0].score >= 0.3);
  assert.ok(data.highlights[0].peakTs > 0);
});

// ─── v3: 单 uid 刷屏限幅 ───

test('single-uid spam is capped per second', () => {
  const engine = createHighlightEngine('t6', '__test__', '123', nullLogger, null);
  for (let i = 0; i < 10; i++) engine.feedDanmaku('刷屏内容' + i, 'spammer');
  // 同一秒内单 uid 最多计 3 条
  assert.strictEqual(engine.getStats().danmaku5s, 3);
});

test('unknown-uid (REST channel) danmaku is NOT capped', () => {
  const engine = createHighlightEngine('t6b', '__test__', '123', nullLogger, null);
  // REST gethistory 批量到达、无 uid——不能按"同一用户刷屏"限幅
  for (let i = 0; i < 10; i++) engine.feedDanmaku('REST 弹幕' + i);
  assert.strictEqual(engine.getStats().danmaku5s, 10);
});

// ─── v3: 情绪词典短词只在短弹幕中匹配 ───

test('short emotion words do not match inside long texts', () => {
  const engine = createHighlightEngine('t7', '__test__', '123', nullLogger, { laugh: ['草'] });
  engine.setRecordingStart(Date.now() / 1000 - 200);
  // 12 个不同用户发不同的长文本（含"草"字）：若短词误匹配 eScore=1 会过阈值
  for (let i = 0; i < 12; i++) engine.feedDanmaku('这个草莓真的特别好吃' + i, 'u' + i);
  assert.strictEqual(engine.getStats().lastHighlightTime, null);
});

// ─── v3: 音频峰 attach 用峰值中心比较 ───

test('audio peak attaches to nearby highlight by peak center', () => {
  const name = '__test_attach__';
  const engine = createHighlightEngine('t8', name, '123', nullLogger, { praise: ['666'] });
  engine.setRecordingStart(Date.now() / 1000 - 200);
  for (let i = 0; i < 12; i++) engine.feedDanmaku('666', 'u' + i);
  assert.notStrictEqual(engine.getStats().lastHighlightTime, null);

  // 无 segStartTs 的 legacy 路径：高光中心 = startOffset + 300，音频峰在其 60s 内
  engine.feedAudioResult([{ startOffset: 290, endOffset: 292, maxDb: -5 }], 'src.mp4', null);

  const data = HighlightStore.getAll(name, localDate());
  assert.strictEqual(data.highlights.length, 1); // attach 而非新建
  assert.strictEqual(data.highlights[0].audioPeakDb, -5);
  assert.ok(data.highlights[0].triggers.includes('audio_peak'));
});

// ─── v3: 观众数信号 ───

test('viewer count surge is tracked', () => {
  const engine = createHighlightEngine('t9', '__test__', '123', nullLogger, null);
  engine.feedViewerCount(100);
  engine.feedViewerCount(100);
  engine.feedViewerCount(160);
  const stats = engine.getStats();
  assert.strictEqual(stats.viewerCount, 160);
  assert.strictEqual(stats.viewerScore, 1); // 60s 内 +60% ≥ 50% → 满分
});
