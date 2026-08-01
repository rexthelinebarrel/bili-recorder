const test = require('node:test');
const assert = require('node:assert');

const { decodePbStrings } = require('../lib/danmaku-parser');

test('decodePbStrings: normal fields parse correctly', () => {
  // field 1 varint 150; field 2 string "ab"
  const buf = Buffer.from([0x08, 0x96, 0x01, 0x12, 0x02, 0x61, 0x62]);
  const r = decodePbStrings(buf);
  assert.deepStrictEqual(r, [{ fieldNum: 2, val: 'ab' }]);
});

test('decodePbStrings: >5-byte varint length does NOT loop forever (CPU/OOM 根因回归)', () => {
  // field 2 wiretype 2，长度 varint 6 字节：旧代码 len |= (b&0x7f)<<shift 在 shift≥32 环绕出负数，
  // offset += len 倒退 → 死循环（strings 无限增长 → OOM，或原地空转 → CPU 打满）
  const evil = Buffer.from([0x12, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x41, 0x41, 0x41]);
  const r = decodePbStrings(evil); // 旧代码此处永不返回
  assert.ok(Array.isArray(r));
});

test('decodePbStrings: unterminated varint at buffer end does not loop', () => {
  // 长度 varint 全部带 continuation bit 直到 buffer 结束
  const evil = Buffer.from([0x12, 0x80, 0x80, 0x80, 0x80]);
  const r = decodePbStrings(evil);
  assert.ok(Array.isArray(r));
});

test('decodePbStrings: zero-length string field advances correctly', () => {
  const buf = Buffer.from([0x12, 0x00, 0x12, 0x01, 0x61]);
  const r = decodePbStrings(buf);
  assert.deepStrictEqual(r, [{ fieldNum: 2, val: '' }, { fieldNum: 2, val: 'a' }]);
});
