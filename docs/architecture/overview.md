# 整体架构

最后更新：`2026-11-09`

## 组件划分

### `apps/web` (`@soqaro/web`)

- Next.js 15 (React 19) 前端，提供自适应网页工作区、房间页、工程级说明页与播放器 UI
- 维护全局持久房间运行时（`PersistentRoomRuntime`），在用户穿梭于大厅、歌单、画像、设置与房间之间时保持底层音频 Context 与实时引擎常驻不重载
- 支持离开房间态（Away Room），在离开房间后维持低延迟后台收听并提供悬浮返回入口
- 基于 View Transition API 实现卡片、门廊弹窗、房间工作区的双向无缝连续形变（Active Room Shell Morph）
- 本地优先存储：深度支持 File System Access API 目录授权与 IndexedDB 个人本地资产缓存，服务端零音频沉淀
- 音频导入管线内置 Bounded Segment Encoding Queue，对分片转码实施并发上限控制，杜绝批量导入时浏览器 OOM 崩溃

### `apps/desktop` (`@soqaro/desktop`)

- Tauri 2 跨平台桌面客户端（Rust + Web，支持 Windows、macOS 与 Linux）
- 集成 Windows SMTC（系统媒体传输控制）/ macOS Now Playing / Linux MPRIS 原生媒体通知与硬件多媒体快捷键
- 支持独立透明置顶的桌面悬浮歌词窗口（带视口边界防护与位置持久化记忆）与原生更新检查

### `apps/mobile` (`@soqaro/mobile`)

- Capacitor 7 移动原生包装工程（Android / iOS）
- 集成 Android 原生 MediaSession 与前台播放服务（持 Partial WakeLock 与 WLAN 锁），保障熄屏与切后台时持续协同不中断
- 深度适配 Android 返回键优先级栈（浮层 -> 房间 -> 防误触退出）

### `apps/server` (`@soqaro/server`)

- NestJS 11 服务端，提供 REST API、Socket.IO 信令网关、房间/队列/播放权威协调和短期 TURN 配置下发
- 服务端仅保存播放权威基准时钟和音频元数据，不持久化任何音频文件
- 网易云音乐、QQ 音乐和 B 站（哔哩哔哩）provider 只在取流和导入阶段短暂代理音频流，导入完成后完全由浏览器本地生成并保存 Opus 播放资产

### `packages/shared` (`@soqaro/shared`)

- 前后端共享的 Zod schema、TypeScript 类型定义与业务模型常量
- 包含 `RoomSnapshot`、`PlaybackSnapshot`、分段资产清单与 WebRTC/播放诊断模型

### `packages/opus-encode` (`@soqaro/opus-encode`)

- Web 与移动端转码包，基于 Web Workers 与 WebAssembly 将本地音频或 Provider 临时流转码为标准 2 秒分段 Opus 资产

## 播放主流程

```text
本地授权目录 / IndexedDB 缓存
  -> SegmentedOpusEngine (响度均衡 + 调度)
  -> 共享 AudioContext 输出总线
  -> MediaStreamAudioDestinationNode
  -> WebRTC RTP Opus
  -> 监听端单一 audio.srcObject
```

房间普通快照、presence、成员变化、队列刷新和音量变化不会重建媒体会话。只有切换 source peer、离开房间或媒体会话彻底重建时才释放输出 Track。

WebRTC 的 `soqaro-control` DataChannel 只用于控制和连接健康协调，音频不经过 DataChannel，也不在成员之间传输原始或播放资产。多人听歌只认一种条件：房间曲目必须拥有可被源成员分发的本地歌曲资产。第三方源缓存不能直接作为多人播放依据；源成员离线或资产缺失时房间统一暂停播放。源成员在线时，引擎自动按优先级（本地文件 -> 本地缓存 -> IndexedDB -> 第三方下载）准备分段 Opus 资产并登记至房间，激活统一房间时钟。不会从其他成员或服务端寻找替代音频源。

## 基础设施

- PostgreSQL：账号、房间、歌单和播放权威状态
- Redis：房间 patch、presence 和跨实例协作
- coturn：WebRTC 中继
- Nginx：Web、API、WebSocket 反代

## 代码分层与目录约定

> 本节是代码审查后的结构契约：新增代码按此归属，改动时保持层间方向不变。

### apps/web 分层（自上而下，依赖只允许向下）

```text
src/
├── app/                 # Next.js 路由：仅做页面装配与数据获取入口，不放业务逻辑
│   └── admin/sections/  # 后台管理按功能 tab 拆分
├── components/          # UI 组件与视图态 hooks
│   ├── room/            # 房间视图（纯 UI 状态；业务动作调 features/room）
│   ├── bottom-player/   # 播放器外壳
│   └── ...
├── features/            # 业务逻辑层（不允许 import components/）
│   ├── room/            # 房间运行时、实时状态、分片播放 runtime
│   ├── playback/        # 播放引擎、provider 缓存与下载、歌词
│   ├── library/         # IndexedDB/本地目录资产（唯一数据层入口，UI 禁止深路径引入）
│   ├── p2p/             # WebRTC 连接生命周期
│   └── ...
└── lib/                 # 与业务无关的通用层：网络客户端、平台探测、通用 UI 工具
    └── network/         # soqaro-api（唯一 fetch 出口；components 禁止直连 fetch）
```

依赖规则：

1. `components → features → lib`，禁止反向；`features` 之间引用走对方 barrel（如 `features/p2p/index.ts`），禁止深路径穿透内部文件。
2. 网络请求只经 `lib/network/soqaro-api*`；IndexedDB 只经 `features/library`；运行时平台探测只经 `lib/desktop/tauri.ts`。
3. 高频（≥10Hz）更新状态不得放在布局级组件 state——用独立 Provider/context 隔离，只让叶子组件消费（先例：`components/room/room-lyrics-position.tsx`）。
4. 大列表渲染一律走渐进渲染模式（先例：`ProviderAlbumTrackTable`，50 行起步每 40ms 追加）。
5. 单文件软上限约 600 行；超过时按职责块拆分（先例：`bilibili.service` → service/lyric-matcher/mappers）。

### apps/server 分层（module 内）

```text
modules/<domain>/
├── *.controller.ts      # HTTP/WS 入口：鉴权、校验、限流，不含业务规则
├── *.service.ts         # 业务编排（门面），复杂域再拆 services/ 子服务
├── repositories/        # 持久化与缓存读写（room 模块）
├── *.mappers.ts         # 平台响应 → 领域模型的纯函数映射
└── *.schemas.ts         # zod 入参校验
```

依赖规则：

1. provider 平台（netease/qqmusic/bilibili）共享的基础设施已收口：`provider-fetch.ts`（SSRF 防护）、`provider-rate-limiter.ts`、`provider-stream.ts`（流代理搬运）。新增平台必须复用，不得再拷贝 streamAudio。
2. 上游 API 客户端超时只约束“建连+响应头”；流式转发不受计时器约束。
3. `common/` 只放真正跨模块的基础件；`infra/`（prisma/redis）是唯一持久化出口。
4. 房间状态写路径必须走 `roomRecordRepository.persistRecord`（CAS 保护），禁止绕过直写 prisma。

### packages/shared

前后端唯一类型契约层。凡是 HTTP/WS 载荷、房间快照结构，先改这里再在两端落地，禁止两端各自声明。

## 结构债治理与推进记录

| 优先级 | 项 | 状态 | 说明 |
|---|---|---|---|
| P1 | 统一服务端测试装配 | 已完成 | 全部 24 处 `@Optional()` 清零（生产 DI 缺失即刻失败）；`room-graph.ts` 的 `buildRoomCoreServices` 为生产与单测共用的唯一房间域装配点；spec 的 mock 收窄单点化 |
| P1 | room-record.repository 拆分 | 已完成 | 888→634 行；终止流程拆 `room-termination.store.ts`，track 删除事件拆 `room-track-deletion.store.ts`；repository 以组合方式内部持有，公开 API 不变、调用方零改动 |
| P2 | admin/page.tsx 按 tab 拆分 | 已完成 | page.tsx 1858→267 行；拆分为 `app/admin/sections/{overview,rooms,users,incidents,audit,system,announcements}.tsx` |
| P2 | provider 面板合并 | 已完成 | `ProviderSourcePanel.tsx` 单一实现，平台差异收敛为 adapter 配置；原文件名保留为薄包装，调用方零改动 |
| P2 | BottomPlayer 进度外部化 | 已完成 | 沉浸模式高频推进移交 `ImmersivePlayerOverlay` 自驱动，BottomPlayer 不再 20fps 整树重渲染；seek/barrier/暂停时冻结展示权威值 |
| P2 | room hooks 归位与 scaffold | 规划中 | 含业务/API 的 hooks 从 `components/room/hooks/` 迁 `features/room/`，Radio/Request/Dashboard 抽共享脚手架 |
| P3 | 4MB base64 wasm 懒 chunk | 规划中 | `@wasm-audio-decoders/flac` 懒加载优化，不影响首屏加载 |
| P3 | migrate-p2p-v4.ts 归档清理 | 已完成 | 历史一次性脚本清理完毕，代码库保持整洁 |
