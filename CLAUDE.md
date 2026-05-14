# bili-recorder Project Guide

B站直播自动录制助手。Node.js 零依赖服务器 + 原生 HTML 前端。

## Architecture

```
server.js (single file, ~620 lines)
├── Logger        → app.log
├── Store         → config.json (JSON persistence)
├── BiliAPI       → B站 v2 API calls
├── getFfmpegArgs → encoding args by format
├── Recorder      → ffmpeg process management
├── Poller        → 30s interval state machine
└── HTTP Server   → REST API + static file serving

index.html (single file, ~330 lines)
└── Vanilla HTML/CSS/JS, dark mode, editorial aesthetic
```

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Streamers + recordings + orphaned |
| POST | `/api/streamer` | Add streamer (roomId/URL/b23.tv) |
| DELETE | `/api/streamer/:id` | Remove streamer (?deleteFiles=true) |
| POST | `/api/streamer/:id/start` | Manual start recording |
| POST | `/api/streamer/:id/stop` | Manual stop recording |
| PUT | `/api/streamer/:id/quality` | Set quality (auto/high/medium/low) |
| PUT | `/api/streamer/:id/format` | Set format (flv/mkv/ts/mp4) |
| GET | `/api/settings` | Get global settings |
| PUT | `/api/settings` | Update global settings |
| POST | `/api/check` | Trigger immediate poll |
| POST | `/api/convert` | FLV→MKV remux |
| POST | `/api/open-file` | Open file in system player |
| DELETE | `/api/recording?filePath=` | Delete recording file |

## Key Data Model

```js
streamer: {
  id, roomId, name, realRoomId, status, recording,
  quality: 'auto', format: 'flv', lastLiveTime, lastFilePath
}
```

## Known Pitfalls

1. **B站 API v1 已死** — `room/v1/Room/playUrl` returns -400. Must use `xlive/web-room/v2/index/getRoomPlayInfo`
2. **Username lookup** — `room/v1/Room/get_info` doesn't return `anchor_info.uname` anymore. Need second call to `live_user/v1/Master/info?uid=`
3. **Windows ffmpeg** — `proc.exitCode` can be garbage (0xCC...). Use event-driven detection (error/exit events + settled flag)
4. **ffmpeg not in PATH** — `findFfmpegPath()` scans winget dirs automatically
5. **403 from B站 CDN** — Must pass `-headers "Referer: https://live.bilibili.com\r\nUser-Agent: Mozilla/5.0..."`
6. **MP4 moov atom** — Unplayable during recording. Guard in frontend, not fixable without frag_mp4
7. **Server restart** — Reset all streamers to offline on startup, migrate orphaned recording dirs
8. **Name migration** — When B站 username is fetched, auto-move files from old dir (房间XXX) to new dir

## File Locations

- `D:\rex\bili-recorder\server.js` — Backend
- `D:\rex\bili-recorder\index.html` — Frontend
- `D:\rex\bili-recorder\config.json` — Runtime config (gitignored)
- `D:\rex\bili-recorder\app.log` — Runtime log
- `D:\rex\bili-recorder\recordings/` — Video output (gitignored)
- `D:\rex\bili-recorder\start.bat` — Daemon launcher
- `D:\rex\bili-recorder\restart-server.ps1` — Kill + restart
- `D:\rex\bili-recorder\setup-check.bat` — Prerequisites checker

## Commands

```powershell
# Start daemon (auto-restart on crash)
.\start.bat

# Restart (kill old + start new)
powershell -ExecutionPolicy Bypass -File restart-server.ps1

# One-time start (no auto-restart)
node server.js

# Check environment
.\setup-check.bat
```

## Features by Implementation Date

See `CHANGELOG.md` for full history.
