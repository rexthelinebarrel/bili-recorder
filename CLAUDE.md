# bili-recorder 项目指南

B站直播自动录制 + 高光检测 + 自动切片。Node.js 服务器 + 原生 HTML 前端。

## 新对话快速上手路径

1. **先读** `server.js`（仅启动引导，~90 行）+ `lib/api-router.js`（全部 HTTP 路由）
2. **再读** `lib/highlight-engine.js` 了解高光检测规则
3. **再读** `lib/danmaku-parser.js` 了解弹幕 WebSocket 协议
4. **最后读** `index.html` 了解前端
5. 看 `app.log` 最近 30 行确认当前运行状态

## 架构

```
server.js (~90 行) — 仅启动引导：崩溃处理、状态重置、目录迁移、HTTP listen
lib/
├── api-router.js      → 全部 HTTP 路由（瘦身后只做参数校验+调度）
├── store.js           → config.json 原子写持久化（tmp+rename，损坏自动备份 .bak）
├── logger.js          → app.log
├── bili-api.js        → B站 API 封装 (getRoomInfo, getStreamUrl, resolveRoomId)
├── recorder.js        → ffmpeg 进程管理 (isWritingTo/activeIds 封装内部状态)
├── poller.js          → 30s 轮询状态机, _offlineSince 宽限期
├── danmaku-manager.js → WebSocket + REST 双通道弹幕管理
├── danmaku-parser.js  → B站 WebSocket 弹幕二进制协议
├── highlight-engine.js→ 多信号融合规则引擎
├── highlight-store.js → 高光 JSON 持久化 (每主播每天一个文件)
├── audio-analyzer.js  → PCM RMS 音频能量峰值检测 (detectPeaks 纯函数可测)
├── clip.js            → 切片核心：pickSourceFiles / clipHighlight / autoClipAfterStream
├── lifecycle.js       → 停录收尾统一流程：finalizeStreamer / cleanupAllRecordings
└── utils.js           → localDate / mergeDirContents / isPathInside

auto-clip.js           → 独立手动切片脚本 (备用)
danmaku-diag.js        → WebSocket 诊断工具
test-danmaku-rest.js   → REST API 测试工具
test/                  → node:test 单测 (npm test)
```

## 高光引擎 (highlight-engine.js, v3)

多信号融合评分，权重：情绪 0.37 / 一致性 0.32 / 加速度 0.16 / z-score 0.15（和=1），观众数涌入额外 +0.1。阈值 0.3，触发间隔 10min，冷却 3min。

v3 关键机制：
- **基线门控**：基线样本 < 30 时 z 因子不参与（防开播初期误报）
- **刷屏限幅**：单 uid 每秒最多计 3 条
- **绝对量下限**：cScore 需 ≥3 个不同用户且分母下限 10；aScore 除数下限 8
- **短词保护**：情绪词典 ≤2 字的词只在短弹幕中匹配（"草" 不命中 "草莓"）
- **观众数信号**：`feedViewerCount`（poller 30s 喂一次），60s 涨 50% → 满分
- **峰值中心**：窗口中心取最近 15s 弹幕最多的一秒，而非过阈值当下
- **音频 attach**：音频峰与高光按峰值中心 ±60s 比较（跨分片用 segments.json 换算墙钟）
- **关键词可配置**：`config.json` 的 `keywordPatterns`（正则字符串数组），主播级可覆盖

关键常量：`CLIP_BEFORE_S=300` `CLIP_AFTER_S=300` `MIN_HIGHLIGHT_INTERVAL_S=600` `MIN_BASELINE_SAMPLES=30` `UID_CAP_PER_SEC=3`

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

- 已推送至 origin/master（d1d6af4，含四轮重构）
- 3 个主播: 人形鹿头自走炮(1163043), 尽力局局长老二(31001522), 真夜みやこ(21272532)
- WebSocket 弹幕收不到 DANMU_MSG，REST 降级稳定（主力弹幕通道，传 nickname 当 uid 用）
- 高光引擎 v3：多信号融合评分 + 观众数信号，切片走 segments.json 分片表墙钟映射

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
11. **`toISOString().slice(0,10)` 是 UTC 日期** — 北京时间早 8 点前"今天"是昨天，高光会归错日期文件。一律用 `lib/utils.js` 的 `localDate()`（前端用 `todayStr()`）
12. **API 的 filePath 必须校验在 savePath 之内** — CORS 已收紧为本机来源，但路径校验是最后防线，加新端点时用 `pathAllowed()`
13. **ffmpeg `-y` 是覆盖不是追加** — 重连"复用"同一文件路径会截断已录内容。重连必须录新分片文件，高光剪切靠 `segments.json` 分片表做墙钟映射（高光带 `peakTs`；音频高光带 `sourceFile`，其偏移是文件内偏移）

## 未来改进方向 (brainstorm 过，未实现)

- **分数区分度**: 当前所有高光 score 0.6，改用弹幕速率×z-score 乘积拉开差距
- **合并相邻高光**: 30s 内两个高峰合并而不是跳过
- **帧级精确切片**: 当前 -c copy 切点对齐关键帧（差几秒），精确切需边界重编码（慢，不值得）
- **短片段模式**: 现在固定 ±5min 窗口，可改为按高光类型动态窗口（1-2min）

## 常用命令

```powershell
node server.js                           # 启动服务器
npm test                                 # 运行 node:test 单测
curl http://localhost:3456/api/status    # 查看状态
node auto-clip.js 0 <streamerId> 5       # 手动切片
tail -30 app.log                         # 看最近日志
node danmaku-diag.js                     # 诊断弹幕连接
node test-danmaku-rest.js                # 测试 REST 弹幕 API
```
