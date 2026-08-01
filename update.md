# 重构记录（2026-08-01）

本次为纯重构 + 健壮性修复，不改变外部 API 与功能行为。JS 总量从 3309 行降至 2831 行（净删约 480 行重复/死代码），新增 21 个 `node:test` 单测全部通过。

## P0 重复代码消除

- **停录收尾流程统一**：原在 `/stop`、`/shutdown`、`/exit`、`poller` 中重复 4 次的"音频分析 → 停弹幕 → 更新基线 → 自动切片"流程，收敛到新模块 `lib/lifecycle.js`（`finalizeStreamer` / `cleanupAllRecordings`）。其中 `/shutdown` 与 `/exit` 曾逐行重复约 40 行。
- **切片逻辑收敛**：`lib/clip.js` 抽出 `pickSourceFiles` / `clipHighlight` / `listSourceCandidates`，`/api/highlights/clip` 端点与 `autoClipAfterStream` 共用，删除约 90 行孪生代码。
- **目录迁移统一**：3 处"旧目录合并到新目录"逻辑（server.js / poller.js / api-router.js）收敛到 `lib/utils.js` 的 `mergeDirContents`。

## P1 架构分层

- `api-router.js` 从 687 行瘦身至约 480 行：房间号/短链解析下沉为 `BiliAPI.resolveRoomId`，业务逻辑全部走共享 helper。
- 封装私有状态：新增 `Recorder.isWritingTo()` / `Recorder.activeIds()`、`DanmakuManager.activeIds()`、`Store.getEmotionDict()` / `setEmotionDict()`，外部不再直接访问 `_processes` / `_parsers` / `_data`。
- 删除死代码 `findBestSourceFile`（只有 import、无调用）。

## P2 健壮性修复

- **config.json 原子写**：`store.js` 改为 tmp+rename，崩溃不再留下半个 JSON；解析失败时先备份为 `config.json.bak` 再回退默认配置，不再静默覆盖主播列表。配置路径可用环境变量 `BILI_RECORDER_CONFIG` 注入（供测试隔离）。
- **ffprobe 探测修复**：原先 `path.dirname(FFMPEG_BIN)` 推导在 ffmpeg 来自 PATH 时失效，导致 `isValidMP4` 永远失败、源文件 fallback 机制静默失灵；改为独立探测。
- **UTC 日期 bug 修复**：`toISOString().slice(0,10)` 是 UTC 日期，北京时间早 8 点前会把高光归到前一天的文件。后端 6 处、前端 4 处、auto-clip.js 1 处全部改用本地日期（`lib/utils.js` 的 `localDate()` / 前端 `todayStr()`）。
- 关键位置的静默 `catch {}` 改为 `logger.warn`；REST 弹幕轮询错误日志增加节流（8s 轮询，避免断网时刷屏）。

## P3 安全加固

- 所有接收 `filePath` 的端点（删除录制 / 转码 / 打开文件 / 打开目录 / 切片）校验路径必须位于 `savePath` 之内，越界返回 403。
- CORS 从 `*` 收紧为仅 localhost 来源（页面由本服务同源提供，不受影响；防止恶意网页通过浏览器调用本地 API 删除文件）。

## 测试与工程化

- 新增 `test/` 4 个文件 21 个用例：utils、store（原子写/损坏恢复）、clip（候选筛选/源文件选择）、api 冒烟（CORS/路径校验/路由）。运行方式：`npm test`。
- `CLAUDE.md` 架构文档更新至当前状态，"教训与陷阱"新增 UTC 日期与路径校验两条。
- `config.json` 移出 git 跟踪（`git rm --cached`，工作文件保留），录制状态变化不再产生 diff 噪音。

## 未改动

- `index.html` 前端未拆分（732 行内联 JS/CSS）：拆分需新增静态文件路由且无测试覆盖，风险大于收益。
- 路由表 if 链保留（未引入框架），后续如需再加端点可考虑改路由数组。

---

# 第二轮重构（2026-08-01，同日）

继续处理第一轮未动的模块，功能保持不变。测试从 21 个增至 26 个，全部通过。

## 重复消除

- **audio-analyzer.js**：删除与 recorder.js 重复的 `findFfmpeg()`（第三份 winget 探测拷贝），直接复用 `FFMPEG_BIN`。
- **danmaku-manager.js**：REST 弹幕轮询的内联 https-get-JSON 改为复用 `BiliAPI._get`（`_get` 新增可选 headers 参数），消除第三份 HTTP 样板。
- **danmaku-parser.js**：`DANMU_MSG` / `INTERACT_WORD_V2` / `LIKE_INFO_V3_CLICK` 三处重复的 danmaku 对象构建收敛为 `emitDanmaku()`。
- **api-router.js**：子路由 id 提取收敛为 `streamerRouteId()` / `streamerRouteExactId()`，`find(s => s.id === id)` 收敛为 `getStreamer()`。

## 效率修复

- **audio-analyzer.js 流式缓冲**：原先每个 stdout chunk 都 `Buffer.concat` 全量拷贝（2 小时录像约 230MB PCM，O(n²) 拷贝）；改为攒够 64 帧（3.2s 音频）统一处理一次，余量留到下一轮。
- stderr 日志截断到 2KB，避免长录像分析时内存膨胀。

## 可测试性 / 小修

- 峰值检测逻辑抽为纯函数 `detectPeaks(frameDbArr)`，新增 5 个单测（空输入/平坦音频/持续高峰/短爆发过滤/双峰分离）。
- **recorder.js**：新增 `formatToExt()`，`Recorder.start` 不再用 `getFfmpegArgs('','',fmt,q)` 空调用取扩展名；`getFfmpegArgs` 的 mkv/ts 分支合并。
- DELETE `/api/streamer/:id` 改为精确路径匹配，避免 `DELETE /api/streamer/:id/start` 这类畸形路径被误当删除主播处理。
- CLAUDE.md 修正 audio-analyzer 描述（原为 PCM RMS 检测，不是 silencedetect）。

---

# 第三轮：切片链路修复（2026-08-01，同日）

针对切片正确性的两个隐患 + 两个健壮性问题。测试从 26 个增至 31 个，全部通过。

## 修复的问题

- **断线重连覆盖 bug（数据丢失）**：旧版重连"复用"同一文件路径，但 ffmpeg `-y` 参数会截断覆盖，重连前已录内容直接丢失；且 `_streamStartTime` 不重置导致后续高光偏移全部错位。改为重连录到新分片文件。
- **高光偏移 → 文件映射**：新增**分片表**（`recordings/<主播>/segments.json`，每段记录 filePath + 起止墙钟时间）。弹幕/礼物高光现在带 `peakTs`（墙钟秒），切片时经 `mapWallRangeToSegment` 定位到正确分片和文件内偏移；音频高光带 `sourceFile`（其偏移本就是文件内偏移），直接按源文件切。旧数据（无 peakTs/sourceFile）退回原启发式。
- **切片产物校验**：endOffset 先用 ffprobe 实际时长钳制；产物 < 1MB 视为失败（ffmpeg 对超范围偏移会静默产空文件），删除空文件并尝试下一个候选源。
- **候选源扩展名泛化**：`listSourceCandidates` 从写死 `.mp4` 改为 `VIDEO_EXTS`（flv/mkv/ts 录制也能享受 fallback）。

## 接口变化

- `Recorder.start(streamerId, roomId, streamerName)`：移除 reusePath 参数
- `clipHighlight({ streamerName, date, h, sources, clipDir })`：filesToTry → sources（每项带自己的偏移）
- `isValidMP4` 更名 `isValidVideo`；新增 `getVideoDuration`
- `engine.feedAudioResult(peaks, sourceFile)`：新增第二参数
- 新增 `clip.js` 导出：`loadSegments` / `mapWallRangeToSegment` / `buildSources`

---

# 第四轮：高光检测引擎 v3（2026-08-01，同日）

检测算法十项优化全做。测试从 31 个增至 37 个，全部通过。

## Bug 修复

- **音频 attach 死代码**：原实现拿高光的 clip 起点（峰值−300s）和音频峰值比较，差恒为 ~300s，attach 永不成功。改为峰值中心 ±60s 比较；跨分片场景经 `segments.json` 把音频峰换算成墙钟时间再比（`feedAudioResult(peaks, sourceFile, segStartTs)`）。
- **冷启动 z-score 虚高**：基线样本 < 30（`MIN_BASELINE_SAMPLES`）时 z 因子不参与评分，开播初期不再误报。

## 统计加固

- **单 uid 刷屏限幅**：每秒每 uid 最多计 3 条（`UID_CAP_PER_SEC`），z-score/加速度不再被单人刷屏灌水（情绪分原文保留，不受影响）。
- **cScore 绝对量下限**：需 ≥3 个不同 uid 说同一内容，分母下限从 5 提到 10，小房间不再轻易触发"观众一致反应"。
- **aScore 除数下限**：从 4 提到 8，0→4 条的小爆发不再拿满分。
- **情绪词典短词保护**：≤2 字的词只在短弹幕（≤词长+2）中匹配，"草"不再命中"草莓"、“牛”不再命中"牛奶"。

## 新信号与设计调整

- **观众数涌入**：`feedViewerCount` 实现（poller 每 30s 喂 `getRoomInfo` 返回的 online），60s 内涨 50% → viewerScore 1.0，以 +0.1 加权进总分（不进权重和），≥0.5 触发 `viewer_surge`。
- **tScore 移除**：权重 0.05 恒为常数无区分度，权重重新归一为 情绪 0.37 / 一致性 0.32 / 加速度 0.16 / z-score 0.15。
- **峰值中心定位**：切片窗口中心取最近 15s 内弹幕最多的一秒，而不是过阈值的当下。
- **关键词正则可配置**：`config.json` 新增 `keywordPatterns`（字符串数组，启动时自动迁移），主播级可用 `streamer.keywordPatterns` 覆盖；`Store.getKeywordPatterns/setKeywordPatterns` 访问器。

## 接口变化

- `createHighlightEngine(id, name, roomId, logger, emotionDict, keywordPatterns)`：新增第 6 参数（缺省用内置正则）
- `feedAudioResult(audioPeaks, sourceFile, segStartTs)`：新增第 3 参数
- `feedViewerCount(count)`：从空函数变为真正实现
- `getStats()` 新增 `viewerCount` / `viewerScore` 字段
- `BiliAPI.getRoomInfo` 返回新增 `online` 字段

---

# 扫尾检查修复（2026-08-01，同日）

重构后复查发现两个 REST 弹幕通道的回归/隐患，已修复（38 个测试全过）：

- **v3 刷屏限幅误伤 REST 通道（严重）**：REST 轮询 `feedDanmaku(m.text)` 不传 uid，所有弹幕 uid=0，会被"单 uid 每秒限 3 条"误判为同一用户刷屏——而 REST 是主力弹幕通道（WebSocket 已收不到 DANMU_MSG），且 gethistory 批量到达恰好落在同一秒。修复：uid 未知（falsy）时跳过限幅，并补回归测试。
- **REST 弹幕无 uid 导致 cScore 恒为 0**：一致性分析按 uid 去重，uid 全 0 时任何文本组都只有 1 个"用户"，`consensus` 触发器在 REST 通道下永远不生效。修复：REST 轮询改传 `nickname` 作为用户标识（gethistory 返回该字段）。

---

# 第五轮：真实直播间实测（2026-08-01）

用血狼破军直播间（8432038，高能房间）实跑了完整链路（开播检测→录制→双通道弹幕→停录→音频分析→基线→自动切片），抓到并修复 6 个真实问题。测试 38→42 个，全部通过。

## 根因级 bug：protobuf varint 死循环（生产事故级）

**现象**：服务器运行几分钟后 OOM（4GB/分钟级增长）或 CPU 打满且事件循环冻结（HTTP 无响应、日志断流），间歇性发作。

**定位过程**：CPU 采样（进程健康）→ 堆快照（健康）→ 二分禁用 WS 弹幕（恢复健康）→ 解压炸弹假设（64MB 上限无效，离线解压落盘负载 0ms 完成，排除）→ 离线复现 `decodePbStrings` 死循环。

**根因**：`danmaku-parser.js` 的 protobuf length-delimited 字段解析用 `len |= (b & 0x7f) << shift` 累加 varint，shift≥32 时 JS 位移按 mod 32 环绕，算出**负数长度**，`offset += len` 倒退造成死循环。循环中 strings 数组无限增长 → OOM；原地空转 → CPU 打满。INTERACT_WORD_V2 消息的 pb 负载只在特定数据下触发，所以是间歇性的。

**修复**：varint 改用浮点乘法累加（安全到 2^53）、超 10 字节判畸形、len 负值/越界即中止、外层加迭代保险丝。新增 4 个回归测试（含超长 varint、截断 varint、零长字段）。

## 实测中修复的其他问题

- **baseline 永不更新（存量 bug）**：`finalizeStreamer` 里 `updateStreamerBaseline` 在 `DanmakuManager.stop()` 之后调用，引擎已被删除、永远 early-return。已调整顺序，实测日志确认 `[baseline] Updated` 输出。
- **segments.json 历史分片不闭合**：崩溃/强杀留下 `endTs: null` 的开口分片，墙钟映射会把新高光错配到最早的开口分片。修复：新分片开始时闭合所有旧开口分片。
- **手动停止录制被 poller 撤销**：/stop 后 poller 在 2min 重连窗口内自动恢复录制。修复：/stop 时写 `gaveUpAt`，10min 退避期内不自动重连。
- **REST 弹幕静默断流**：去重水位 `_lastTime` 只认字符串比较，置顶/预约消息的异常 timeline（未来时间）会污染水位，导致后续弹幕被永久去重且无日志。修复：timeline 格式校验 + 超当前时间 5min 丢弃 + gethistory code!=0 时节流日志。

## 验证结果

- 修复后浸泡：CPU ~0%，内存 72MB 稳定，弹幕连续流
- 停录全链路：stop → 音频分析（10216 帧）→ baseline 更新 → 分片闭合 → auto-clip → 无自动重连 ✓
- 事件循环冻结与 OOM 在修复后未再复现
