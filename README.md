# bili-recorder

B站直播自动录制助手。添加主播房间号，开播自动录制，下播自动停止。

## 依赖

- [Node.js](https://nodejs.org/) (v18+)
- [ffmpeg](https://ffmpeg.org/) (需在 PATH 中可用)

## 快速开始

```bash
# 安装 ffmpeg（如未安装）
# Windows: winget install ffmpeg
# macOS: brew install ffmpeg
# Linux: apt install ffmpeg

# 启动
npm start
```

打开 `http://localhost:3456`

## 使用说明

1. 输入 B站房间号（直播间 URL 里的数字），点击"添加"
2. 系统每 30 秒自动检查一次，检测到开播立即开始录制
3. 点击"立即检查"可手动触发检测
4. 录制文件保存在 `./recordings/<主播名>/` 目录下
5. 可在设置中修改保存路径

## 录制流程

- 开播 → 自动启动录制
- 下播 → 自动停止
- 断线 2 分钟内 → 自动重连续录
- 断线超 2 分钟 → 开新文件

## 文件格式

- 视频格式: FLV
- 画质: 原画（最高画质）
- 命名: `YYYY-MM-DD_HH-MM-SS.flv`
