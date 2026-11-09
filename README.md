# Soqaro

<p align="center">
  <b>跨平台多端协同听歌与音乐房应用</b><br>
  面向私有本地音乐与多源流媒体的高保真协同收听平台，基于 WebRTC RTP Opus 实现毫秒级低延迟同步。
</p>

<p align="center">
  <a href="./README.md"><b>简体中文</b></a> / <a href="./README.en.md"><b>English</b></a>
</p>

<p align="center">
  <a href="https://github.com/witw123/soqaro/releases/latest"><img src="https://img.shields.io/github/v/release/witw123/soqaro?style=flat-square&color=24292e&label=Release" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-24292e?style=flat-square" alt="License"></a>
  <a href="https://github.com/witw123/soqaro/releases/latest"><img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20Web-24292e?style=flat-square" alt="Platforms"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22.x-24292e?style=flat-square" alt="Node.js"></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-10.x-24292e?style=flat-square" alt="pnpm"></a>
</p>

---

## 软件下载

当前稳定版本：[Soqaro v1.0.0](https://github.com/witw123/soqaro/releases/tag/v1.0.0)（支持桌面端自动更新）

| 操作系统 | 架构 | 安装包类型 | 下载直链 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| Windows | x64 | NSIS 安装程序 (`.exe`) | [Soqaro_1.0.0_x64-setup.exe](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.0_x64-setup.exe) | 桌面置顶歌词与系统媒体控制 (SMTC) |
| Windows | x64 | WiX 安装包 (`.msi`) | [Soqaro_1.0.0_x64_en-US.msi](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.0_x64_en-US.msi) | 企业分发与静默安装 |
| macOS | Universal | DMG 镜像 (`.dmg`) | [Soqaro_1.0.0_universal.dmg](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.0_universal.dmg) | 原生适配 Apple Silicon 与 Intel 架构 |
| macOS | Universal | 更新归档 (`.app.tar.gz`) | [Soqaro_universal.app.tar.gz](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_universal.app.tar.gz) | 客户端内置自动更新校验包 |
| Linux | x86_64 | AppImage | [Soqaro_1.0.0_amd64.AppImage](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.0_amd64.AppImage) | 通用便携免安装执行包 |
| Linux | x86_64 | Debian (`.deb`) | [Soqaro_1.0.0_amd64.deb](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.0_amd64.deb) | 适用于 Ubuntu / Debian / Deepin 等 |
| Linux | x86_64 | RPM (`.rpm`) | [Soqaro-1.0.0-1.x86_64.rpm](https://github.com/witw123/soqaro/releases/latest/download/Soqaro-1.0.0-1.x86_64.rpm) | 适用于 Fedora / RHEL / openSUSE 等 |
| Android | Universal | APK 安装包 (`.apk`) | [Soqaro-Android-v1.0.0.apk](https://github.com/witw123/soqaro/releases/latest/download/Soqaro-Android-v1.0.0.apk) | 原生 MediaSession 与后台服务常驻保活 |
| Web | 现代浏览器 | PWA 在线应用 | [在线访问](https://soqaro.witw.top/app) | 浏览器即开即用，支持 PWA 离线安装 |

> [!NOTE]
> **安装与运行说明**  
> - **macOS**：首次打开如遇系统 Gatekeeper 拦截提示，可在终端执行 `sudo xattr -cr /Applications/Soqaro.app` 放行。  
> - **Linux**：AppImage 文件需在运行前赋予执行权限：`chmod +x Soqaro_1.0.0_amd64.AppImage`。  
> - **Android**：生产发布包已签名，首次安装请在系统弹窗中允许来自当前应用源的安装。

---

## 功能特性

### 实时协同与声学引擎
- **毫秒级同步广播**：基于 WebRTC RTP Opus 实时广播与分段 Opus 调度引擎，曲目拥有者作为单一音频源，全房间成员低延迟同步收听。
- **本地优先架构**：用户音频资产严格保存在客户端本地文件授权目录与 IndexedDB 缓存中，服务端零音频数据沉淀。
- **离线无缝降级**：集成网易云音乐、QQ 音乐与哔哩哔哩（多 P 视频音频提取）；源成员离线时自动切换至监听端备用流。
- **受限队列防 OOM**：内置 Bounded Segment Encoding Queue 分段转码队列与并发限流机制，支持任务取消，杜绝批量导入时浏览器内存暴涨与崩溃。
- **智能声学控制**：支持单曲循环、列表循环、Fisher-Yates 随机洗牌（防连续重复），并提供基于响度分析的自动增益对齐（Loudness Normalization）。

### 房间模式与一镜到底流转
- **多元房间形态**：
  - **协作房 (Interactive)**：全员共享队列，支持自由点歌、切歌、拖拽调序与投票跳过。
  - **点歌台 (Request)**：观众搜索点歌提交申请，房主集中审核批准入队。
  - **漫游电台 (Radio)**：基于口味偏好的自动化连续广播漫游。
- **一镜到底连续过渡**：基于 View Transition 规范实现卡片、门廊弹窗、房间工作区的双向无缝连续形变（Active Room Shell Morph），消灭界面切换时的闪烁与突变。
- **离开房间后台持久收听 (Away Room)**：离开房间浏览大厅、画像或歌单时，房间音频通过全局持久运行时保持低延迟播放，并提供随时一键返回的悬浮入口。

### 多端原生系统集成
- **全平台客户端覆盖**：提供基于 Next.js 15 的响应式 Web/PWA、基于 Tauri 2 的跨平台桌面端（Windows / macOS / Linux）及基于 Capacitor 7 的原生 Android 端。
- **系统媒体桥接**：深度接入 Windows SMTC、Linux MPRIS、macOS Now Playing、Android 原生 MediaSession、系统锁屏播控通知与硬件快捷键。
- **后台常驻保活**：Android 端持有前台音频服务、WLAN 锁与部分唤醒锁，保障熄屏与切后台时持续协同不中断。

### 歌词、交互与收敛视觉
- **高精度双语歌词**：支持标准 LRC 滚动歌词与 YRC 逐字精准高亮，内置双语对照、罗马音音译注音与桌面置顶悬浮歌词。
- **独立置顶歌词窗口**：桌面端提供无边框、半透明、防遮挡的悬浮歌词窗口，支持视口边缘吸附与位置记忆。
- **收敛视觉规范**：遵循 Radix UI Colors 配色方案与 0.5px 精细描边规范，高信息密度实体表面，杜绝过度渐变、大投影与无意义装饰。

---

## 系统架构

```text
[ 本地音乐文件 / 外部平台导入 ]
               │
               ▼
[ 本地目录授权 / IndexedDB 缓存 ] (分段 Opus 转码队列防 OOM)
               │
               ▼
[ SegmentedOpusEngine ] (本地音频调度引擎 + 响度均衡)
               │
               ▼
[ WebRTC RTP 音频广播 ] ─── (服务端信令协同) ───► [ 房间各监听端单一音频总线 ]
```

---

## 快速开始

### 依赖环境

| 组件 | 最低版本要求 | 用途说明 |
| :--- | :--- | :--- |
| Node.js | 22.x | 前端与后端运行环境 |
| pnpm | 10.x | Monorepo 包管理器 |
| PostgreSQL | 16.x | 用户、房间与元数据持久化 |
| Redis | 7.x | 实时播放状态与信令协调 |
| Docker | 推荐 | 本地开发容器化运行数据库与中间件 |

### 本地开发

```bash
# 1. 安装依赖
pnpm install

# 2. 初始化环境配置与中间件容器（PowerShell 下复制命令为 Copy-Item .env.example .env）
cp .env.example .env
docker compose up -d postgres redis
pnpm --filter @soqaro/server db:push

# 3. 启动开发服务器（Web: 3000, Server: 3001）
pnpm dev
```

### 常用指令

```bash
pnpm build          # Monorepo 全量构建
pnpm lint           # ESLint 代码规范检查 (--max-warnings=0)
pnpm typecheck      # TypeScript 静态类型检查
pnpm test           # 运行全套单元测试
pnpm desktop:dev    # 启动桌面端开发窗口
pnpm mobile:sync    # 同步 Web 构建产物至 Android 原生工程
```

---

## 仓库结构

```text
soqaro/
├── apps/
│   ├── web/          # Next.js 15 Web 客户端、PWA、音频调度引擎与 WebRTC 核心
│   ├── desktop/      # Tauri 2 跨平台桌面客户端（Rust + SMTC/MPRIS + 桌面悬浮歌词）
│   ├── mobile/       # Capacitor 7 原生 Android 客户端（MediaSession + 后台保活）
│   └── server/       # NestJS 11 API 服务端与 Socket.IO 信令网关
├── packages/
│   ├── shared/       # 前后端通用模型、Zod 校验与 TypeScript 类型定义
│   ├── opus-encode/  # 浏览器端分段 Opus 音频编码工具
│   └── config-*/     # Monorepo 统一 TypeScript 与 ESLint 规范配置
├── docs/             # 完整技术架构文档、API 协议与部署手册
└── deploy/           # 生产部署配置模版（Docker Compose、Nginx、coturn）
```

---

## 工程文档

- [系统架构概览](./docs/architecture/overview.md)
- [本地存储仓库设计](./docs/architecture/local-storage.md)
- [播放同步链路原理解析](./docs/architecture/playback-sync.md)
- [REST API 与 WebSocket 协议说明](./docs/api/README.md)
- [Docker 生产环境部署指南](./docs/deployment/deployment.md)
- [TURN 网络穿透配置清单](./docs/deploy/turn-network-checklist.md)

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 协议开源。
