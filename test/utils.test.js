const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { localDate, mergeDirContents, isPathInside } = require('../lib/utils');

test('localDate returns local YYYY-MM-DD', () => {
  const d = new Date(2026, 0, 5, 9, 30); // 2026-01-05 09:30 local
  assert.strictEqual(localDate(d), '2026-01-05');
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('isPathInside', () => {
  const parent = path.join(os.tmpdir(), 'rec');
  assert.strictEqual(isPathInside(parent, path.join(parent, 'a', 'f.mp4')), true);
  assert.strictEqual(isPathInside(parent, parent), false); // 目录本身不算"之内"
  assert.strictEqual(isPathInside(parent, path.join(os.tmpdir(), 'other', 'f.mp4')), false);
  assert.strictEqual(isPathInside(parent, path.join(parent, '..', 'evil.txt')), false);
});

test('mergeDirContents moves files and removes old dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'br-utils-'));
  const oldDir = path.join(base, 'old');
  const newDir = path.join(base, 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'a.txt'), '1');
  fs.writeFileSync(path.join(oldDir, 'b.txt'), '2');

  const count = mergeDirContents(oldDir, newDir);
  assert.strictEqual(count, 2);
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'a.txt'), 'utf-8'), '1');
  assert.strictEqual(fs.existsSync(oldDir), false);

  // 不存在的旧目录 → 0，不报错
  assert.strictEqual(mergeDirContents(path.join(base, 'nope'), newDir), 0);
  // 同目录 → 0
  assert.strictEqual(mergeDirContents(newDir, newDir), 0);

  fs.rmSync(base, { recursive: true, force: true });
});
