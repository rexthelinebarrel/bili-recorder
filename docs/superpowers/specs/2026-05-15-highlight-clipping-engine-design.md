# Highlight Clipping Engine — Design Spec

## Overview

给 bili-recorder 增加直播高光时刻自动标注能力。采集弹幕、礼物、音频等多维信号，通过规则引擎输出切片时间区间，Web 面板预览后批量裁剪。

## Architecture Decision: Hybrid Mode

- **实时层**（直播进行中）：弹幕 WebSocket 持续连接，轻量信号（弹幕密度、礼物事件、关键词刷屏）即时评分，超阈值写时间戳标注
- **离线层**（录制完成后）：对已录制文件做音频短时能量分析，补充音频维度，修正评分
- 实时层不接触 ffmpeg 管线，不影响现有录制的稳定性

## File Structure

```
server.js                  (新增 API + 调度钩子，~50 行增量)
lib/
  danmaku-parser.js        (弹幕 WebSocket 客户端，B站 BROTLI 协议解析)
  audio-analyzer.js        (ffmpeg silencedetect + RMS 能量检测，离线批处理)
  highlight-engine.js      (规则引擎：信号融合 + 阈值判断 + 去重合并)
  highlight-store.js       (JSON 文件持久化，按主播+日期分文件)
index.html                 (新增切片面板：标注列表、预览、批量裁剪)
```

## Signal Pipeline

### P0 — 弹幕密度峰值（实时）

- 协议：B站弹幕 WebSocket `wss://broadcastlv.chat.bilibili.com/sub`
- 方法：滑动窗口（5s 窗口，1s 步长），维护在线基线（前 60s 均值+标准差），当前窗口密度 > 基线 3σ 触发
- 实现：Node.js 原生 `net` 模块 + 自写 BROTLI 解压（或引入单个 brotli npm 包）

### P0 — 礼物事件（实时）

- 协议：同上 WebSocket，`CMD_SEND_GIFT`（普通礼物）和 `CMD_GUARD_BUY`（大航海/舰长）
- 方法：累加 10s 窗口内礼物金额（金瓜子 → 人民币），> 100 元触发
- 高价值事件（总督/提督）单独触发，不等窗口

### P0 — 弹幕关键词刷屏（实时）

- 方法：正则匹配高光关键词组
  - 问号风暴：`/^\？{2,}$/` 或 5s 内 `？` 占比 > 50%
  - 确认句式：`/^(666+|牛[逼批bB]+|卧槽|wc|名场面|合影|录屏|保存|截图).*$/`
- 阈值：5s 窗口内匹配条数 > 总弹幕 30% 或绝对数量 > 10 条

### P1 — 音频短时能量（离线）

- 输入：已完成录制的视频文件（优先 FLV/MKV，MP4 在编码完成后再分析）
- 方法：
  1. ffmpeg 提取音轨为 WAV（16kHz mono）
  2. ffmpeg `silencedetect` 滤镜标记静默段，取反得活跃段
  3. 活跃段内计算 RMS 短时能量（50ms 帧长），对比全片基线
  4. 能量 > 基线 3σ 且持续 > 2s 标记为音频高点
- 触发时机：Poller 检测到录制结束（主播下播或手动停止）后自动调度

### P2 — 观众数拐点（实时）

- 方法：Poller 已有 30s 轮询，复用 `online_count`
- 计算：维持过去 5 分钟人数序列，一阶导数 > 阈值（如 30s 内增长 > 20%）触发

## Rule Engine

纯信号组合，不引入 ML。所有实时信号汇聚到 `highlight-engine.js`：

```
trigger 条件（满足任一）:
  1. 弹幕密度 > 3σ  AND  礼物价值 > 100元/10s
  2. 弹幕密度 > 3σ  AND  关键词刷屏触发
  3. 弹幕密度 > 5σ  (超级峰值，独立触发)
  4. 总督/提督购买  (独立触发)
  5. (离线补标) 弹幕密度 > 3σ  AND  音频能量 > 3σ

去重：同一区间内多次触发合并，最小间隔 30s
输出：{ startTime, endTime, score, triggers[], suggestedTitle }
```

评分公式（简单加权）：

```
score = danmakuScore * 0.35 + giftScore * 0.30 + keywordScore * 0.25 + audioScore * 0.10
每个子信号归一化到 [0, 1]
```

## Data Model

`recordings/<主播名>/highlights.json`:

```json
{
  "streamerId": "xxx",
  "roomId": "12345",
  "date": "2026-05-15",
  "highlights": [
    {
      "id": "uuid",
      "startOffset": 1234.5,
      "endOffset": 1250.0,
      "duration": 15.5,
      "score": 0.87,
      "triggers": ["danmaku_peak", "gift_burst"],
      "danmakuCount": 45,
      "peakDanmakuRate": 9.2,
      "totalGiftValue": 230,
      "audioPeakDb": -6.3,
      "title": "五杀团灭弹幕爆炸",
      "clipped": false,
      "clipFile": null,
      "createdAt": "2026-05-15T20:30:00Z"
    }
  ]
}
```

## New API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/highlights?streamerId=&date=` | 获取标注列表 |
| POST | `/api/highlights/clip` | 批量裁剪 `{ ids[], streamerId, filePath }` |
| DELETE | `/api/highlights/:streamerId/:id` | 删除单条标注 |
| PUT | `/api/highlights/:streamerId/:id` | 手动调整区间 `{ startOffset, endOffset }` |

裁剪实现：调用 ffmpeg `-ss startOffset -to endOffset -i source.mkv -c copy clipped.mp4`，注意 keyframe 对齐（`-ss` 在 `-i` 前用于快速 seek，可能有 1-2s 精度偏差；如需精确切在非关键帧，需要 `-c:v libx264` 重编码）

## Frontend: 切片面板

在 `index.html` 新增一个 tab/区域，放在录制文件管理旁边：

- 按主播+日期筛选
- 标注列表：时间轴图示 + 评分 + 触发信号标签 + 建议标题
- 行内预览按钮：调用 `/api/open-file` 从该时间点播放
- 多选复选框 + 一键裁剪按钮
- 已裁剪标注显示 clipFile 链接

## Implementation Phases

### Phase 1 — 弹幕信号采集 + 实时标注（MVP 核心）

- `lib/danmaku-parser.js`
- `lib/highlight-engine.js`（仅 P0 信号）
- `lib/highlight-store.js`
- server.js 集成：Poller 检测到直播开始 → 启动 danmaku-parser；直播结束 → 关闭
- 基础 API：GET highlights, DELETE highlight

### Phase 2 — 离线音频分析

- `lib/audio-analyzer.js`
- highlight-engine 增加音频信号维度
- 录制完成自动触发离线分析

### Phase 3 — Web 面板 + 批量裁剪

- 前端切片面板
- POST `/api/highlights/clip`
- ffmpeg 裁剪管线

## Non-Goals (for now)

- 视觉帧分析（成本高、延迟大，留到后期）
- ML 模型融合（先跑通规则，攒够标注数据再说）
- 自动标题生成（同理，先人工确认）
- 一键分发到短视频平台
- 多平台弹幕支持（只做 B站）
