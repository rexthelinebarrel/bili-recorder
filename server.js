const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  streamers: [],
  settings: { savePath: path.join(__dirname, 'recordings') }
};

const Store = {
  _data: null,

  load() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      this._data = JSON.parse(raw);
    } catch {
      this._data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.save();
    }
    return this._data;
  },

  save() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this._data, null, 2), 'utf-8');
  },

  getAll() { return this._data; },

  getStreamers() { return this._data.streamers; },

  addStreamer(s) {
    this._data.streamers.push(s);
    this.save();
    return s;
  },

  removeStreamer(id) {
    this._data.streamers = this._data.streamers.filter(s => s.id !== id);
    this.save();
  },

  updateStreamer(id, updates) {
    const idx = this._data.streamers.findIndex(s => s.id === id);
    if (idx !== -1) {
      Object.assign(this._data.streamers[idx], updates);
      this.save();
    }
  },

  getSettings() { return this._data.settings; },

  updateSettings(updates) {
    Object.assign(this._data.settings, updates);
    this.save();
  }
};

Store.load();
