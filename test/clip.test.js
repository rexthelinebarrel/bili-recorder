const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 避免测试 require 链里的 store 单例读到真实 config.json
process.env.BILI_RECORDER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-cfg-')), 'config.json');

const { listSourceCandidates, pickSourceFiles, MIN_SOURCE_SIZE } = require('../lib/clip');
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
