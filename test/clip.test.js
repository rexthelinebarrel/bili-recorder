const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 避免测试 require 链里的 store 单例读到真实 config.json
process.env.BILI_RECORDER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-cfg-')), 'config.json');

const { listSourceCandidates, pickSourceFiles, MIN_SOURCE_SIZE, mapWallRangeToSegment, buildSources } = require('../lib/clip');
const { localDate } = require('../lib/utils');

// 用 truncate 造稀疏文件，瞬间得到"大文件"而不真的写几十 MB
function makeSparseFile(fp, size) {
  fs.closeSync(fs.openSync(fp, 'w'));
  fs.truncateSync(fp, size);
}

test('listSourceCandidates: filters and today-boost ordering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-clip-'));
  const todayFile = path.join(dir, `主播_${localDate()}_12-00-00.mp4`);
  const oldFile = path.join(dir, '主播_2020-01-01_12-00-00.mp4');
  makeSparseFile(todayFile, MIN_SOURCE_SIZE + 1024);        // 刚好达标，今日加权 ×10
  makeSparseFile(oldFile, MIN_SOURCE_SIZE * 8);             // 更大但非今日
  makeSparseFile(path.join(dir, 'x_clip_10s_20s.mp4'), MIN_SOURCE_SIZE * 10); // 切片产物，排除
  makeSparseFile(path.join(dir, 'small.mp4'), 1024);        // 太小，排除
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');        // 非 mp4，排除

  const candidates = listSourceCandidates(dir);
  assert.deepStrictEqual(candidates, [todayFile, oldFile]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pickSourceFiles: keeps original when no valid fallback exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-clip-'));
  const small = path.join(dir, 'frag.mp4');
  makeSparseFile(small, 1024); // 碎片文件，但目录里没有有效候选（假 mp4 过不了 ffprobe）

  const { mainFile, fallbackFiles } = pickSourceFiles(small);
  assert.strictEqual(mainFile, small);
  assert.deepStrictEqual(fallbackFiles, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pickSourceFiles: nonexistent file does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-clip-'));
  const missing = path.join(dir, 'missing.mp4');
  const { mainFile } = pickSourceFiles(missing);
  assert.strictEqual(mainFile, missing);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSourceCandidates: accepts all video extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-clip-'));
  const mkv = path.join(dir, `主播_${localDate()}_rec.mkv`);
  makeSparseFile(mkv, MIN_SOURCE_SIZE + 1024);
  const candidates = listSourceCandidates(dir);
  assert.deepStrictEqual(candidates, [mkv]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 分片表映射 ───

const SEGMENTS = [
  { filePath: 'a.mp4', startTs: 1000, endTs: 2000 },
  { filePath: 'b.mp4', startTs: 2100, endTs: null }  // 仍在录制
];

test('mapWallRangeToSegment: basic mapping and clamping', () => {
  // 完全落在第一段内
  assert.deepStrictEqual(
    mapWallRangeToSegment(SEGMENTS, 1500, 1800),
    { filePath: 'a.mp4', startOffset: 500, endOffset: 800 }
  );
  // 超出第一段末尾 → 钳制到 endTs
  assert.deepStrictEqual(
    mapWallRangeToSegment(SEGMENTS, 1900, 2200),
    { filePath: 'a.mp4', startOffset: 900, endOffset: 1000 }
  );
  // 落在两段之间的断流空隙 → null
  assert.strictEqual(mapWallRangeToSegment(SEGMENTS, 2050, 2150), null);
  // 进行中的分片（endTs null）按 Infinity 处理
  assert.deepStrictEqual(
    mapWallRangeToSegment(SEGMENTS, 2500, 2800),
    { filePath: 'b.mp4', startOffset: 400, endOffset: 700 }
  );
});

test('buildSources: sourceFile 优先（音频高光）', () => {
  const h = { id: 'x', startOffset: 10, endOffset: 610, sourceFile: 'rec1.flv', peakTs: 1500 };
  assert.deepStrictEqual(buildSources(h, null, SEGMENTS), [
    { filePath: 'rec1.flv', startOffset: 10, endOffset: 610 }
  ]);
});

test('buildSources: peakTs 经分片映射（弹幕高光）', () => {
  const h = { id: 'y', startOffset: 200, endOffset: 800, peakTs: 1600 };
  assert.deepStrictEqual(buildSources(h, null, SEGMENTS), [
    { filePath: 'a.mp4', startOffset: 300, endOffset: 900 }  // 1600±300 → [1300,1900] → 段内 [300,900]
  ]);
});

test('buildSources: 无 peakTs/sourceFile 时退回启发式', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-clip-'));
  const f = path.join(dir, 'main.mp4');
  makeSparseFile(f, 1024);
  const h = { id: 'z', startOffset: 0, endOffset: 600 };
  const sources = buildSources(h, f, []);
  assert.deepStrictEqual(sources, [{ filePath: f, startOffset: 0, endOffset: 600 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
