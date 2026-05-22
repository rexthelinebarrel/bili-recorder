# 高光引擎 v2 — 轻量语义层 + 信号优化

## 问题诊断

基于 2026-05-17 / 05-19 三天实际数据分析（3主播 × 2天 = 6个 JSON，12个高光）：

| 问题 | 数据表现 |
|---|---|
| Score 无区分度 | 12/12 score=0.6，min(1, z/10) 在 z 略超 5 时饱和 |
| 低弹幕噪音误触发 | 3条/5s 触发 Rule 3，小主播基线为 0 导致微小波动 z→∞ |
| 录制开头全高光 | 5/12 startOffset=0，启动时批量弹幕误标 |
| 重连导致 offset 错误 | recordingStartTime 被 DanmakuManager 重新 start 时重置 |
| Rule 1/2/4/5 从未触发 | 礼物¥100/关键词10条门槛对小主播过高 |
| Clip 文件错乱 | 5/19 高光用 5/17 源文件切，嵌套重切 |

## 优化方案

### 1. 新评分模型

从单一 z-score 改为多因子加权融合：

```
score = eScore × 0.35    // 情绪密度
      + cScore × 0.30    // 弹幕一致性
      + aScore × 0.15    // 加速度
      + zScore × 0.15    // z-score（降权）
      + tScore × 0.05    // 时间位置
```

每个因子 0-1 归一化。绝对底线：5s 窗口 < 3 条弹幕不触发。

### 2. 情绪词典（可编辑）

`config.json` 新增 `emotionDict`：

```json
{
  "emotionDict": {
    "laugh": ["哈哈", "笑死", "草", "www", "草生", "hhhh"],
    "surprise": ["？？", "卧槽", "啊？", "什么", "我去", "wc"],
    "praise": ["666", "牛逼", "太强了", "牛", "帅", "好强"],
    "mock": ["离谱", "逆天", "不愧是你", "就这", "典", "急"]
  }
}
```

- eScore = min(1, 情绪命中数 / 总弹幕数 × 3)
- 同一 uid 在 5s 窗口内重复发相同词只算 1 次
- 前端设置面板提供 textarea 编辑（一行一词），持久化到 config.json

### 3. 弹幕一致性

检测多个不同用户说相似内容 → 集体反应信号。

```
cScore = 重复最大组人数 / max(5, 5s内活跃用户数)
```

- 仅统计长度 ≥ 2 的文本
- 相同 uid 相同文本去重
- 活跃用户少时门槛自动降低

### 4. 加速度 + 时间位置

**加速度**：当前窗口 vs 前一窗口弹幕倍率。

```
aScore = min(1, (current - previous) / max(4, previous × 2))
```

**时间位置**：录制中段权重最高。

```
tScore =
  0.0   offset < 3min（冷却期硬过滤）
  0.5   3-5min 或 最后 5min
  1.0   中间段
```

### 5. 自适应基线

按主播维护跨 session 基线，存储在 config.json 每个 streamer 上：

```json
{
  "baseline": {
    "meanDanmakuRate": 0.12,
    "stdDanmakuRate": 0.08,
    "updatedAt": "2026-05-19",
    "sampleCount": 45
  }
}
```

- 每次下播时合并本次录制数据更新基线
- 新主播无历史时回退到 session 内 60s 窗口
- z-score 在基线稳定后不易误触发

### 6. Bug 修复

- **recordingStartTime 不复位**：新增 `streamStartTime`（录制首次启动时间），重连时不重置
- **找源文件的逻辑**：优先当天最大 mp4，不跨天回退

## 改动清单

| 文件 | 改动 |
|---|---|
| `lib/highlight-engine.js` | 新评分模型、情绪密度、一致性、加速度、时间位置、自适应基线 |
| `config.json` | 新增 `emotionDict`，streamer 新增 `baseline` |
| `server.js` | 重连不复位 offset，下播时更新基线，找源文件当天优先 |
| `index.html` | 设置区加情绪词典编辑面板 |

## 后续迭代方向（不在本次范围）

- LLM 离线分析弹幕时间轴判断上下文
- 音频笑声/沉默检测
- 画面变化检测
- 各因子权重可调（前端面板）
