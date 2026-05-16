const fs = require('fs');
const path = require('path');

const HIGHLIGHTS_DIR = path.join(__dirname, '..', 'recordings');

function filePath(streamerName, date) {
  return path.join(HIGHLIGHTS_DIR, streamerName, `highlights_${date}.json`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFile(streamerName, date) {
  try {
    const raw = fs.readFileSync(filePath(streamerName, date), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { streamerName, date, highlights: [] };
  }
}

function writeFile(streamerName, date, data) {
  const fp = filePath(streamerName, date);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
}

function generateId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

const HighlightStore = {
  getAll(streamerName, date) {
    return readFile(streamerName, date);
  },

  add(streamerName, date, highlight) {
    const data = readFile(streamerName, date);
    const now = new Date().toISOString();

    highlight.id = generateId();
    if (!highlight.createdAt) highlight.createdAt = now;

    const threshold = 30;
    for (const existing of data.highlights) {
      const gap = Math.max(0, Math.max(existing.startOffset, highlight.startOffset) - Math.min(existing.endOffset, highlight.endOffset));
      const startDist = Math.abs(existing.startOffset - highlight.startOffset);
      if (startDist < threshold || gap === 0) {
        existing.startOffset = Math.min(existing.startOffset, highlight.startOffset);
        existing.endOffset = Math.max(existing.endOffset, highlight.endOffset);
        existing.duration = existing.endOffset - existing.startOffset;
        existing.score = Math.max(existing.score, highlight.score);
        existing.triggers = [...new Set([...existing.triggers, ...highlight.triggers])];
        existing.danmakuCount = Math.max(existing.danmakuCount || 0, highlight.danmakuCount || 0);
        existing.totalGiftValue = Math.max(existing.totalGiftValue || 0, highlight.totalGiftValue || 0);
        existing.peakDanmakuRate = Math.max(existing.peakDanmakuRate || 0, highlight.peakDanmakuRate || 0);
        if (highlight.audioPeakDb !== undefined) {
          existing.audioPeakDb = existing.audioPeakDb !== undefined
            ? Math.max(existing.audioPeakDb, highlight.audioPeakDb)
            : highlight.audioPeakDb;
        }
        if (highlight.title && !existing.title) existing.title = highlight.title;

        writeFile(streamerName, date, data);
        return existing;
      }
    }

    if (!highlight.clipped) highlight.clipped = false;
    if (!highlight.clipFile) highlight.clipFile = null;
    data.highlights.push(highlight);
    writeFile(streamerName, date, data);
    return highlight;
  },

  update(streamerName, date, id, updates) {
    const data = readFile(streamerName, date);
    const idx = data.highlights.findIndex(h => h.id === id);
    if (idx === -1) return null;
    Object.assign(data.highlights[idx], updates);
    writeFile(streamerName, date, data);
    return data.highlights[idx];
  },

  remove(streamerName, date, id) {
    const data = readFile(streamerName, date);
    const idx = data.highlights.findIndex(h => h.id === id);
    if (idx === -1) return false;
    data.highlights.splice(idx, 1);
    writeFile(streamerName, date, data);
    return true;
  },

  listDates(streamerName) {
    const dir = path.join(HIGHLIGHTS_DIR, streamerName);
    try {
      const files = fs.readdirSync(dir);
      const dates = [];
      for (const f of files) {
        const match = f.match(/^highlights_(\d{4}-\d{2}-\d{2})\.json$/);
        if (match) dates.push(match[1]);
      }
      dates.sort((a, b) => b.localeCompare(a));
      return dates;
    } catch {
      return [];
    }
  }
};

module.exports = { HighlightStore };
