const https = require('https');

const BiliAPI = {
  _get(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  },

  async getRoomInfo(roomId) {
    const url = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`;
    const res = await this._get(url);
    if (res.code !== 0) throw new Error(`BiliAPI error: ${res.message}`);
    let name = res.data.title || String(roomId);
    const uid = res.data.uid;
    if (uid) {
      try {
        const userRes = await this._get(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`);
        if (userRes.code === 0 && userRes.data?.info?.uname) {
          name = userRes.data.info.uname;
        }
      } catch {}
    }
    return {
      roomId: String(res.data.room_id),
      name,
      status: res.data.live_status === 1 ? 'live' : 'offline',
      title: res.data.title || ''
    };
  },

  async getStreamUrl(roomId, quality) {
    const qnMap = { auto: 10000, high: 10000, medium: 400, low: 250 };
    const qn = qnMap[quality] || 10000;
    const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0&qn=${qn}&platform=web&ptype=8`;
    const res = await this._get(url);
    if (res.code !== 0) throw new Error(`BiliAPI error: ${res.message}`);
    const streams = res.data?.playurl_info?.playurl?.stream || [];
    // Iterate in reverse — last stream is highest quality
    for (let i = streams.length - 1; i >= 0; i--) {
      for (const format of (streams[i].format || [])) {
        if (format.format_name !== 'flv') continue;
        for (const codec of (format.codec || [])) {
          const baseUrl = codec.base_url || '';
          const host = codec.url_info?.[0]?.host || '';
          const extra = codec.url_info?.[0]?.extra || '';
          if (baseUrl && host) return host + baseUrl + extra;
        }
      }
    }
    throw new Error('No stream URL found');
  }
};

module.exports = BiliAPI;
