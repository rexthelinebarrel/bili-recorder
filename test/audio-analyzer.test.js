const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILI_RECORDER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-cfg-')), 'config.json');

const { detectPeaks } = require('../lib/audio-analyzer');

test('empty input → no peaks', () => {
  assert.deepStrictEqual(detectPeaks([]), []);
});

test('flat audio → no peaks', () => {
  assert.deepStrictEqual(detectPeaks(new Array(2000).fill(-40)), []);
});

test('sustained loud burst is detected with correct offsets', () => {
  // 1000 帧安静（-40dB）+ 60 帧响亮（-10dB，3s ≥ MIN_PEAK_S）+ 1000 帧安静
  const frames = [
    ...new Array(1000).fill(-40),
    ...new Array(60).fill(-10),
    ...new Array(1000).fill(-40)
  ];
  const peaks = detectPeaks(frames);
  assert.strictEqual(peaks.length, 1);
  assert.strictEqual(peaks[0].startOffset, 50);   // 1000 × 50ms
  assert.strictEqual(peaks[0].endOffset, 53);     // 1060 × 50ms
  assert.strictEqual(peaks[0].maxDb, -10);
});

test('short burst below min duration is filtered out', () => {
  // 20 帧（1s < 2s 最短时长）
  const frames = [
    ...new Array(1000).fill(-40),
    ...new Array(20).fill(-10),
    ...new Array(1000).fill(-40)
  ];
  assert.deepStrictEqual(detectPeaks(frames), []);
});

test('two separated bursts produce two peaks', () => {
  const frames = [
    ...new Array(1000).fill(-40),
    ...new Array(50).fill(-10),
    ...new Array(500).fill(-40),   // 25s 间隔 > MERGE_GAP_S
    ...new Array(50).fill(-8),
    ...new Array(1000).fill(-40)
  ];
  const peaks = detectPeaks(frames);
  assert.strictEqual(peaks.length, 2);
  assert.strictEqual(peaks[1].maxDb, -8);
});
