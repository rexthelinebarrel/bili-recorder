# bili-recorder 项目指南

B站直播自动录制 + 高光检测 + 自动切片。Node.js 服务器 + 原生 HTML 前端。

## 新对话快速上手路径

1. **先读** `server.js` 头部（~1-170 行）了解 Store、BiliAPI、Recorder 结构
2. **再读** `lib/highlight-engine.js` 了解高光检测规则
3. **再读** `lib/danmaku-parser.js` 了解弹幕 WebSocket 协议
4. **最后读** `index.html` 了解前端
5. 看 `app.log` 最近 30 行确认当前运行状态

## 架构

```
server.js (~1200 行)
├── Logger          → app.log
├── Store           → config.json (JSON 持久化, Object.assign 内存更新)
├── BiliAPI         → B站 API 封装 (getRoomInfo, getStreamUrl, getDanmuInfo)
├── Recorder        → ffmpeg 进程管理, _processes map, _lastExitedFile
├── Poller          → 30s 轮询状态机, _offlineSince 宽限期
├── DanmakuManager  → WebSocket + REST 双通道弹幕
├── RESTDanmakuPoller → 8s 轮询 gethistory API 降级方案
├── autoClipAfterStream → 下播/手动停止时自动切 top 5 高光
├── findBestSourceFile  → 源文件 < 50MB 自动找最大录制文件
├── HTTP Server     → REST API + index.html 静态服务
└── auto-clip.js    → 独立手动切片脚本 (备用)

lib/
├── highlight-engine.js  → 多信号融合规则引擎
├── highlight-store.js   → JSON 文件持久化 (每主播每天一个文件)
├── danmaku-parser.js    → B站 WebSocket 弹幕客户端
└── audio-analyzer.js    → ffmpeg silencedetect 音频分析

danmaku-diag.js        → WebSocket 诊断工具
test-danmaku-rest.js   → REST API 测试工具
```

## 高光引擎 (highlight-engine.js)

多信号融合，规则优先级从高到低：

| 规则 | 触发条件 | 窗口 | 分数 |
|------|---------|------|------|
| Rule 3 超级弹幕高峰 | danmaku z-score > 5σ | 前后各 5min | min(1, dZ/10) |
| Rule 4 大航海 | 总督(¥19998)/提督(¥1998) | 前后各 5min | min(1, rmb/20000) |
| Rule 1 弹幕+礼物 | z > 3σ + 10s 礼物 > ¥100 | 前后各 5min | dScore×0.5 + giftScore×0.5 |
| Rule 2 弹幕+关键词 | z > 3σ + 关键词 > 10 条或占比 > 30% | 前后各 5min | dScore×0.5 + kwScore×0.5 |
| Rule 5 音频高峰 | post-hoc 匹配或独立创建 | 前后各 5min | 0.3 + 匹配加分 |

关键常量：`CLIP_BEFORE_S=300` `CLIP_AFTER_S=300` `MIN_HIGHLIGHT_INTERVAL_S=600`

## 弹幕协议 (danmaku-parser.js)

B站 WebSocket 二进制协议：
- 16 字节头 (totalLen, headerLen, protoVer, op, seq)
- v3 protobuf → brotli 解压 → 嵌套二进制包 → JSON
- `parseNestedPackets()` 逐包读取 16 字节头 + JSON body
- 处理 cmd: DANMU_MSG, INTERACT_WORD_V2 (protobuf field 12), LIKE_INFO_V3_CLICK, SEND_GIFT, GUARD_BUY

**已知问题：B站已不再通过 WebSocket 下发 `DANMU_MSG`。** REST API `gethistory` 降级方案每 8s 轮询获取弹幕文本。

## 切片流程

三种触发路径都会切片：

1. **自然下播**: poller 检测 offline → 等 3min 宽限期 (`OFFLINE_GRACE_PERIOD`) → 确认后停止录制 → 音频分析 → 切 top 5
2. **手动停止**: 前端点"⏹ 停止录制" → `/api/streamer/:id/stop` → 停止+分析+切片
3. **关闭服务**: 前端点"关闭服务" → `/api/shutdown` → 所有录制停止+分析+切片 → 退出

前端快捷操作：
- 离线卡片上"🎬 切片"按钮 → `quickClip()` → 一键切 top 5
- 高光区"全选 Top 5" + "裁剪选中" → 手动挑选

## 当前状态

- 16 commits ahead of origin/master
- 3 个主播: 人形鹿头自走炮(1163043), 尽力局局长老二(31001522), 真夜みやこ(21272532)
- WebSocket 弹幕收不到 DANMU_MSG，REST 降级稳定
- 高光引擎主要触发 Rule 3 (弹幕超级高峰)，礼物/音频规则很少触发
- 今日高光: 人形鹿头自走炮 1 个 (score 0.6, 3 条弹幕), 真夜みやこ 0 个

## 教训与陷阱

1. **B站 API v1 已死** — 必须用 `xlive/web-room/v2/index/getRoomPlayInfo`
2. **用户名需二次查** — `get_info` 不再返回 uname，需 `live_user/v1/Master/info?uid=`
3. **ffmpeg Windows exit code 乱码** — 用事件驱动 (error/exit + settled flag)，不读 exitCode
4. **MP4 录制中不可播放** — moov atom 在文件尾，前端有 guard
5. **添加主播初始状态 offline** — 已修复：add endpoint 立即检测 live 状态并开始录制
6. **`parseInt('0')` 是 falsy** — 用 `isNaN(parseInt(x))` 判断
7. **高光源文件不匹配** — 服务器重启后小块文件被当源文件。已修复：`findBestSourceFile` 自动找 > 50MB 的录制文件
8. **前端下拉框懒加载死循环** — populate 逻辑在 early return 之后。已修复：移到 return 之前
9. **execSync 调 ffprobe 在 Windows 上不可靠** — 改用 fs.statSync 文件大小判断
10. **B站 brotli v3 负载含嵌套二进制头** — 不能当纯 JSON 解析。用 `parseNestedPackets`

## 未来改进方向 (brainstorm 过，未实现)

- **分数区分度**: 当前所有高光 score 0.6，改用弹幕速率×z-score 乘积拉开差距
- **绝对量阈值**: 弹幕 < 5条/5s 不触发，过滤低活跃噪音
- **加速度因子**: 弹幕从 0→8 比 5→8 更有价值
- **自适应基线**: 按主播历史平均值而非 60s 窗口计算 z-score
- **观众数信号**: `feedViewerCount` 是空函数，观众涌入是高能指标
- **合并相邻高光**: 30s 内两个高峰合并而不是跳过

## 常用命令

```powershell
node server.js                           # 启动服务器
curl http://localhost:3456/api/status    # 查看状态
node auto-clip.js 0 <streamerId> 5       # 手动切片
tail -30 app.log                         # 看最近日志
node danmaku-diag.js                     # 诊断弹幕连接
node test-danmaku-rest.js                # 测试 REST 弹幕 API
```
