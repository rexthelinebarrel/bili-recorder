// utils.js — 共享小工具：本地日期、目录合并、路径校验
const fs = require('fs');
const path = require('path');

// 本地时区的 YYYY-MM-DD（不要用 toISOString().slice(0,10)，那是 UTC 日期，
// 北京时间早 8 点前会把"今天"算成昨天，导致高光归错日期文件）
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 把 oldDir 里的所有文件并入 newDir（用于主播改名/旧目录迁移）。返回迁移的文件数。
function mergeDirContents(oldDir, newDir) {
  if (path.resolve(oldDir) === path.resolve(newDir)) return 0;
  try {
    if (!fs.existsSync(oldDir) || !fs.statSync(oldDir).isDirectory()) return 0;
  } catch {
    return 0;
  }
  fs.mkdirSync(newDir, { recursive: true });
  const files = fs.readdirSync(oldDir);
  for (const f of files) {
    fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
  }
  fs.rmdirSync(oldDir);
  return files.length;
}

// child 是否位于 parent 目录之内（用于 API 的 filePath 安全校验）
function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { localDate, mergeDirContents, isPathInside };
