const fs = require('fs');
const path = require('path');

// 测试可通过 BILI_RECORDER_CONFIG 注入临时配置路径，避免动到真实 config.json
const CONFIG_PATH = process.env.BILI_RECORDER_CONFIG || path.join(__dirname, '..', 'config.json');
const DEFAULT_CONFIG = {
  streamers: [],
  settings: { savePath: path.join(__dirname, '..', 'recordings'), format: 'flv' }
};
const DEFAULT_EMOTION_DICT = {
  laugh: ["哈哈", "笑死", "草", "www", "hhh", "笑死我了"],
  surprise: ["？？", "卧槽", "啊？", "什么", "我去", "wc"],
  praise: ["666", "牛逼", "太强了", "牛", "帅", "好强"],
  mock: ["离谱", "逆天", "不愧是你", "就这", "典", "急"]
};

const Store = {
  _data: null,

  load() {
    try {
      this._data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTFOUND') {
        // 文件存在但解析失败（多半是上次崩溃写了半个 JSON）：
        // 先备份再用默认配置，绝不能直接覆盖，否则主播列表无法找回
        const bak = CONFIG_PATH + '.bak';
        try { fs.copyFileSync(CONFIG_PATH, bak); } catch {}
        console.error(`[store] config.json 解析失败 (${e.message})，已备份到 ${bak}，使用默认配置`);
      }
      this._data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    // Ensure emotionDict exists
    if (!this._data.emotionDict) {
      this._data.emotionDict = JSON.parse(JSON.stringify(DEFAULT_EMOTION_DICT));
      this.save();
    }
    return this._data;
  },

  save() {
    // 原子写：先写临时文件再 rename，避免崩溃时留下半个 JSON
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_PATH);
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
  },

  getEmotionDict() { return this._data.emotionDict || {}; },

  setEmotionDict(dict) {
    this._data.emotionDict = dict;
    this.save();
  }
};

Store.load();

module.exports = Store;
