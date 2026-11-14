# Soqaro

<p align="center">
  <b>Multi-client collaborative listening workspace</b><br>
  High-fidelity collaborative audio workspace for local files and streamed tracks, powered by WebRTC RTP Opus for millisecond-level synchronization.
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

## Downloads

Current stable release: [Soqaro v1.0.1](https://github.com/witw123/soqaro/releases/tag/v1.0.1) (With in-app auto-update support)

| OS | Architecture | Package Type | Direct Download Link | Description |
| :--- | :--- | :--- | :--- | :--- |
| Windows | x64 | NSIS Installer (`.exe`) | [Soqaro_1.0.1_x64-setup.exe](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.1_x64-setup.exe) | Floating lyrics overlay and Windows SMTC integration |
| Windows | x64 | WiX Package (`.msi`) | [Soqaro_1.0.1_x64_en-US.msi](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.1_x64_en-US.msi) | Enterprise distribution and silent installation |
| macOS | Universal | DMG Image (`.dmg`) | [Soqaro_1.0.1_universal.dmg](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.1_universal.dmg) | Native Apple Silicon (M1–M4) and Intel x86_64 bundle |
| macOS | Universal | Update Archive (`.app.tar.gz`) | [Soqaro_universal.app.tar.gz](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_universal.app.tar.gz) | In-app auto-updater archive |
| Linux | x86_64 | AppImage | [Soqaro_1.0.1_amd64.AppImage](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.1_amd64.AppImage) | Portable, standalone executable package |
| Linux | x86_64 | Debian (`.deb`) | [Soqaro_1.0.1_amd64.deb](https://github.com/witw123/soqaro/releases/latest/download/Soqaro_1.0.1_amd64.deb) | For Ubuntu, Debian, Linux Mint, Deepin, etc. |
| Linux | x86_64 | RPM (`.rpm`) | [Soqaro-1.0.1-1.x86_64.rpm](https://github.com/witw123/soqaro/releases/latest/download/Soqaro-1.0.1-1.x86_64.rpm) | For Fedora, RHEL, openSUSE, etc. |
| Android | Universal | APK Package (`.apk`) | [Soqaro-Android-v1.0.1.apk](https://github.com/witw123/soqaro/releases/latest/download/Soqaro-Android-v1.0.1.apk) | Native MediaSession, lockscreen controls, and background service |
| Web | Modern Browsers | PWA Web App | [Launch Web App](https://soqaro.witw.top/app) | Chrome, Edge, Safari, Firefox; installable as a PWA |

> [!NOTE]
> **Installation Notes**  
> - **macOS**: If blocked by Gatekeeper on first open, execute `sudo xattr -cr /Applications/Soqaro.app` in Terminal.  
> - **Linux AppImage**: Grant execution permission before running: `chmod +x Soqaro_1.0.1_amd64.AppImage`.  
> - **Android**: Release APK is signed; allow installation from your browser or file manager when prompted.

---

## Features

### Realtime Collaboration & Acoustic Engine
- **Millisecond-Level Synchronization**: WebRTC RTP Opus audio broadcast paired with a Segmented Opus engine; track owner acts as the single source of truth.
- **Local-First Audio Storage**: User audio assets remain exclusively on client devices (authorized local directories and IndexedDB cache); zero audio stored on the server.
- **Resilient Fallback**: Integrated support for NetEase, QQ Music, and Bilibili (multi-part media extraction); automatic listener-side offline fallback when the track owner disconnects.
- **Bounded Encoding Queue (OOM Protection)**: Bounded segment encoding queue with concurrency throttling and cancellation support, eliminating memory spikes during bulk audio imports.
- **Intelligent Playback Modes**: Sequential, single track loop, list loop, Fisher-Yates random shuffle (guaranteeing no immediate repetition), and automatic loudness normalization.

### Room Modes & Seamless Fluid Transitions
- **Distinct Room Topologies**:
  - **Interactive Mode**: Shared collaborative queue with free track enqueueing, reordering, and skip voting.
  - **Request Mode**: Moderated station where audience members request songs and the host reviews before adding to queue.
  - **Radio Mode**: Automated continuous streaming based on taste preferences.
- **Active Room Shell Morph**: Fluid, continuous bidirectional transitions between room directory cards, threshold modals, and full room workspaces powered by the View Transition API.
- **Away Room Background Persistence**: Room audio continues playing seamlessly across workspace navigation (lobby, profile, playlists) via a persistent background runtime, complete with a floating one-click return entry.

### Native Multi-Platform Integration
- **Full Client Coverage**: Next.js 15 Web/PWA, Tauri 2 cross-platform desktop (Windows / macOS / Linux), and Capacitor 7 native Android client.
- **System Media Bridge**: Unified bridge connecting playback state to Windows SMTC, Linux MPRIS, macOS Now Playing, Android MediaSession, notification controls, and lockscreen widgets.
- **Background Persistence**: Android foreground service with partial wake lock and WLAN lock ensuring uninterrupted playback during screen lock.

### Lyrics, Interaction & Restrained Aesthetics
- **High-Precision Bilingual Lyrics**: Synchronized LRC scrolling and YRC verbatim highlighting with translations, romanized pronunciations, and desktop floating lyrics.
- **Independent Floating Lyrics**: Desktop transparent, borderless floating lyrics window with boundary protection and persistent position memory.
- **Restrained Visual Aesthetics**: Strict Radix UI color tokens, crisp 0.5px hairlines, and solid, high-contrast surfaces without excessive gradients or visual clutter.

---

## Architecture

```text
[ Local Audio Files / Streamed Tracks ]
                   │
                   ▼
[ Local Directory / IndexedDB Cache ] (Bounded Opus Encoding Queue)
                   │
                   ▼
[ SegmentedOpusEngine ] (Local Audio Scheduler + Loudness Normalization)
                   │
                   ▼
[ WebRTC RTP Broadcast ] ─── (Server Signaling) ───► [ Listener Single Audio Bus ]
```

---

## Quick Start

### Prerequisites

| Component | Minimum Version | Purpose |
| :--- | :--- | :--- |
| Node.js | 22.x | Runtime environment for web and server |
| pnpm | 10.x | Monorepo package manager |
| PostgreSQL | 16.x | User, room, and metadata persistence |
| Redis | 7.x | Realtime playback state and coordination |
| Docker | Recommended | Local containerized dependencies |

### Local Development

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment and launch databases
cp .env.example .env
docker compose up -d postgres redis
pnpm --filter @soqaro/server db:push

# 3. Start development servers (Web: 3000, API: 3001)
pnpm dev
```

### Common Commands

```bash
pnpm build          # Monorepo full build
pnpm lint           # ESLint static code checks (--max-warnings=0)
pnpm typecheck      # TypeScript type checking
pnpm test           # Run unit tests
pnpm desktop:dev    # Launch Tauri desktop development window
pnpm mobile:sync    # Sync Web build artifacts to Android project
```

---

## Monorepo Layout

```text
soqaro/
├── apps/
│   ├── web/          # Next.js 15 Web client, PWA, audio scheduler, and WebRTC core
│   ├── desktop/      # Tauri 2 desktop client (Rust + SMTC/MPRIS + floating lyrics)
│   ├── mobile/       # Capacitor 7 native Android client (MediaSession + background persistence)
│   └── server/       # NestJS 11 API server and Socket.IO signaling gateway
├── packages/
│   ├── shared/       # Shared contracts, models, and TypeScript type definitions
│   ├── opus-encode/  # Browser-side Ogg Opus encoder package
│   └── config-*/     # Unified Monorepo TypeScript and ESLint configuration
├── docs/             # Technical architecture, API specifications, and deployment guides
└── deploy/           # Production deployment templates (Docker Compose, Nginx, coturn)
```

---

## Documentation

- [Architecture Overview](./docs/architecture/overview.md)
- [Local Storage Architecture](./docs/architecture/local-storage.md)
- [Playback Synchronization Architecture](./docs/architecture/playback-sync.md)
- [API and WebSocket Protocols](./docs/api/README.md)
- [Production Deployment Guide](./docs/deployment/deployment.md)
- [TURN Network Checklist](./docs/deploy/turn-network-checklist.md)

---

## License

This project is licensed under the [MIT License](./LICENSE).
