# 文档总览

最后更新：`2026-11-09`
当前版本：`1.0.0`

## 当前项目现状

Soqaro 是一套围绕“本地与外部音乐多人同步播放”构建的多端协作应用：

- Next.js 15 Web 前端（自适应桌面与移动端浏览器，支持 PWA，基于 `@soqaro/web`）
- Tauri 2 桌面端（支持 Windows、macOS 与 Linux，集成 Windows SMTC / Linux MPRIS / macOS Now Playing 与桌面独立悬浮歌词，基于 `@soqaro/desktop`）
- Capacitor 7 移动端（支持 Android，集成 Android 原生 MediaSession 与前台音频播放服务，基于 `@soqaro/mobile`）
- NestJS 11 API / Socket.IO 服务端（基于 `@soqaro/server`）
- 共享类型契约与 Schema 层（基于 `@soqaro/shared`）
- 自动化多平台发布矩阵：GitHub Actions `Release Apps` 工作流由 `create-release` 任务协调，矩阵打包并发布 Windows（`.exe`, `.msi`）、macOS（`.dmg`, `.app.tar.gz`）、Linux（`.AppImage`, `.deb`, `.rpm`）与 Android（`.apk`）安装包，并生成 Tauri 自动更新签名及 `latest.json`
- PostgreSQL、Redis、coturn 生产依赖
- 本地优先存储：支持系统目录授权（File System Access API 与 Tauri 本地文件系统）与 IndexedDB 个人音频资产缓存
- 受限转码队列（Bounded Segment Encoding Queue）：并发限流与任务取消支持，彻底杜绝批量导入时浏览器 OOM 崩溃
- 单一 Segmented Opus/WebRTC RTP 媒体广播链路
- 官网展示入口 `/` 与客户端入口 `/app`
- 工作区路由体系：
  - `/app`：房间大厅，分体式自适应 Bento 拼图网格与单列门廊弹窗
  - `/app/discover`：房间推荐与精选策展
  - `/app/playlists`：本地与外部歌单管理，整合全源曲目搜索与批量导入
  - `/app/favorites`：收藏曲目、专辑与歌单
  - `/app/profile`：个人页为「听歌画像 / 房间足迹 / 平台账号」三个 Tab
  - `/app/settings`：独立系统设置路由（常规、播放策略、界面外观、播放体验、通知推送、隐私与数据、账号安全）
  - `/app/admin`：系统监控看板、公告管理与运维巡检
- 房间形态体系：
  - 标准协作房（Interactive）：全员共享队列、协作控制与拖拽调序
  - 点歌台（Request）：观众搜索点歌提交、房主审批入队
  - 漫游电台（Radio）：基于偏好标签的自动化连续广播漫游
- 离开房间态（Away Room）：离开房间浏览大厅、画像或歌单时，房间音频通过全局持久运行时保持低延迟播放，并提供随时一键返回的悬浮入口
- 一镜到底流转（Active Room Shell Morph）：基于 View Transition API 实现卡片、门廊弹窗、房间工作区的双向无缝连续形变

服务端只保存账号、房间、队列、播放状态和音频元数据，不保存音频文件。房间不提供缓存下载、音频资产互传或房间级缓存同步。本地存储与 IndexedDB 用于恢复当前用户自己上传或 provider 导入的歌曲及其本地生成的资产。

当前房间 UI 为：

- `曲库`
- `我的歌单`
- `成员与诊断`

共享队列由房间舞台和持久化播放器管理；房间内的“我的歌单”用于本地歌单、网络歌单和 provider 曲目导入。

## 先看哪几页

- 当前状态：[engineering/status.md](./engineering/status.md)
- 整体架构：[architecture/overview.md](./architecture/overview.md)
- 本地存储仓库设计：[architecture/local-storage.md](./architecture/local-storage.md)
- 播放同步：[architecture/playback-sync.md](./architecture/playback-sync.md)
- 实时链路：[architecture/realtime.md](./architecture/realtime.md)
- Android 发布与签名指南：[deploy/android-release.md](./deploy/android-release.md)
- TURN 网络检查：[deploy/turn-network-checklist.md](./deploy/turn-network-checklist.md)
- 测试策略：[engineering/testing.md](./engineering/testing.md)
- 工程路线：[engineering/roadmap.md](./engineering/roadmap.md)
- 接口文档总览：[api/README.md](./api/README.md)
- REST API：[api/rest.md](./api/rest.md)
- WebSocket 事件：[api/websocket-events.md](./api/websocket-events.md)
- 共享模型：[api/shared-models.md](./api/shared-models.md)
- 测试场景手册：[api/testing-playbook.md](./api/testing-playbook.md)
- 部署说明：[deployment/deployment.md](./deployment/deployment.md)

`refactor/` 下的文档是重构记录或历史提案，除已明确标注“已完成”的播放迁移记录外，不代表当前实现。

## 当前唯一播放链路

```text
本地文件 / IndexedDB 分段 Opus
  -> SegmentedOpusEngine
  -> 共享 AudioContext 输出总线
  -> MediaStreamAudioDestinationNode
  -> WebRTC RTP Opus
  -> 监听端单一 audio.srcObject
```

源端和监听端共享中性的媒体会话身份。成员加入、presence 更新、普通快照、队列刷新和本地音量变化不会重建媒体会话；只有切歌、source peer 变化、媒体连接彻底重建或退出房间才改变/释放输出 Track。

## 重要说明

### Web 默认使用当前页面同源

Web 前端默认使用当前页面 origin，不需要把生产域名硬编码进仓库。

### 当前工程阶段是“可用 + 加固”

核心用户链路已经跑通，当前主要工作集中在单实例发布稳态、真实 WebRTC/Media 集成测试、长时间播放验证、真实设备音频观测和统一生产告警能力。

### 诊断面板是媒体排障入口

“成员与诊断”页用于区分信令、ICE、媒体 RTP、AudioContext、播放缓冲和 Track 绑定问题。诊断重点包括：

- `audioContextState`
- `playbackAssetId` / `mediaSessionKey`
- `outputTrackId` / `remoteTrackId`
- `bufferedAheadMs` / `scheduledAheadMs`
- underrun、limiter peak/RMS、RTP bitrate、jitter 和 packet loss

### Docker Nginx 配置边界

`deploy/linux/nginx/soqaro.conf` 中的 `web:3000` 和 `server:3001` upstream 只适用于 Docker 网络。宿主机部署时必须改为本机地址，例如 `127.0.0.1:3000` 和 `127.0.0.1:3001`。
