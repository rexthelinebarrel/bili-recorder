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

- `danmaku-parser.js`（协议层稳定）、`audio-analyzer.js` 未动。
- 路由表 if 链保留（未引入框架），后续如需再加端点可考虑改路由数组。
