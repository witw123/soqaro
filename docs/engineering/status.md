# 项目状态

最后更新：`2026-11-09`
当前版本：`1.0.0`

## 当前主链路

- 账号、房间、队列和播放控制可用
- 用户上传阶段在浏览器本地生成原始资产和分段 Opus 播放资产
- 本地文件沙盒（授权目录）配合 IndexedDB 保存当前用户自己上传或 provider 导入的歌曲及其本地资产
- `SegmentedOpusEngine` 使用固定的共享 AudioContext 输出总线
- 源端通过 `SegmentedOpusEngine` + shared AudioContext + broadcastDestination 发布 RTP Opus（owner 是唯一媒体源）
- 监听端只使用一个 `audio.srcObject`
- `soqaro-control` DataChannel 只用于控制和连接健康协调
- 诊断协议使用 `segmentedPlaybackStatus` 与 `TrackDistributionBadge`

## 当前产品面

- `/` 是产品展示页，已完成工程级重构：直观呈现四阶段声学数据流架构、三大房间模式对比与本地一键自建指南
- `/app` 是房间大厅，基于 Bento 风格自适应拼图网格排版，支持多渠道过滤（全部、协作房、点歌台、漫游电台）；顶部通知栏集成极简铃铛与自适应容器跑马灯，点击唤起公告中心弹窗
- `/app/discover` 聚焦房间推荐与偏好探索，提供精选房间与活动电台入口
- `/app/playlists` 歌单工作区：管理本地与云端歌单，深度集成网易云音乐、QQ 音乐与 B 站（哔哩哔哩）跨平台搜索、分 P 浏览与曲库导入
- `/app/favorites` 汇集用户收藏曲目、专辑与歌单
- `/app/profile` 个人页为「听歌画像 / 房间足迹 / 平台账号」三个 Tab：画像页以口味标签（点击开启对应偏好漫游电台）为核心，辅以最常播放、常听歌手与音源分布；头部身份卡展示口味摘要、累计收听统计与播放中的“正在收听”信号
- `/app/settings` 独立系统设置路由，涵盖常规、播放策略、界面外观、播放体验、通知推送、隐私与数据、账号安全
- `/app/admin` 管理运维看板：系统健康状态度量、在线房间与连接监视、系统公告管理、缓存清理工具
- 房间工作区：包含 `曲库`、`我的歌单`、`成员与诊断`；共享队列由房间舞台和全局持久化播放器管理
- 房间形态支持三大模式：标准协作房（Interactive，全员协作）、点歌台（Request，观众点歌+房主审批）、漫游电台（Radio，自动化连续广播）
- 离开房间态（Away Room）：用户离开房间返回大厅或其它工作区时，房间实时连接与音频通过全局持久运行时保持后台播放，大厅与侧栏显示快速返回房间的悬浮入口
- 一镜到底流转（Active Room Shell Morph）：基于 View Transition API 实现卡片、门廊弹窗、房间工作区的双向无缝连续形变
- 桌面端（Tauri 2）：支持 Windows SMTC、macOS Now Playing、Linux MPRIS 硬件媒体快捷键与桌面独立透明置顶悬浮歌词
- 移动端（Capacitor 7）：支持 Android 原生 MediaSession、前台常驻播放服务与系统锁屏/通知栏控制

## 稳定性与性能措施

- **批量导入受限队列防 OOM**：引入 Bounded Segment Encoding Queue，对音频分段转码实施并发上限控制，支持超时保护与手动取消，杜绝多文件同时转码爆内存
- **本地目录沙盒授权**：深度支持浏览器 File System Access API 与桌面端 Tauri 原生存储目录授权，本地音频文件安全持久化
- **播放引擎防冲突与响度均衡**：sync single-flight 和 timeline generation 防止旧异步结果污染新时间线；引入 Fisher-Yates 随机洗牌（防连续重播）与自适应响度对齐
- **媒体链路平滑控制**：20ms source fade、欠载静音门和 limiter 降低 click/pop 与削波风险；本地音量和监听端恢复均采用平滑操作
- **会话持久与抗抖动**：房间快照、成员变化、presence 和音量变化不重建媒体会话；暂停、缺片和解码等待不调用 `replaceTrack(null)`；仅媒体会话变化时才替换/释放 output Track 或重新绑定远端 `srcObject`
- **本地播放资产完整性校验**：fallback 校验来源文件 hash、首尾分片索引和 payload 长度，避免选择截断资产

## 已完成

- **1.0.0 正式版发布与品牌统一**：项目全栈更名为 Soqaro，Monorepo 作用域完整切换为 `@soqaro/*`（`@soqaro/server`, `@soqaro/web`, `@soqaro/desktop`, `@soqaro/mobile`, `@soqaro/shared`），全仓库清理历史残留字样。
- **全平台自动化发布流水线落地**：接入 GitHub Actions `Release Apps` 工作流，由 `create-release` 任务协调统一 Release，并发矩阵构建全平台客户端（Windows `.exe` / `.msi`、macOS Universal `.dmg` / `.app.tar.gz`、Linux `.AppImage` / `.deb` / `.rpm`、Android `.apk`），所有发布资产自动回传。
- **Tauri 2 跨平台桌面端与自动更新**：支持 Windows SMTC、Linux MPRIS 与 macOS Now Playing 原生媒体控制与快捷键；支持独立桌面悬浮歌词与 rAF 节流渲染；打通 Tauri Action 自动签名与 `latest.json` 自动更新发布。
- **Capacitor 7 移动端与生产发布签名**：支持 Android 原生 MediaSession、后台音频前台服务常驻与系统锁屏/通知栏交互；建立完整的 CI 密钥库与 Base64 解密签名流（`soqaro-release.jks`），基于语义化版本推导 `versionCode`。
- **官方规范中英文 README 与下载矩阵**：重构根目录 `README.md` 与 `README.en.md`，提供符合主流开源标准的无 emoji、高信息密度表格化多平台下载 UI，直连 GitHub 官方 Releases 产物。
- **房间展厅重构与一镜到底流转体验**：
  - 房间大厅采用自适应 Bento 拼图网格排版，结合响应式分列布局（12/8/6 列）。
  - 落地房间门廊弹窗（Room Threshold Sheet），提供紧凑的单列信息流与一键直达入口。
  - 基于 View Transition API 实现卡片、门廊弹窗、房间工作区的双向无缝连续形变动画（Active Room Shell Morph）。
- **离开房间态（Away Room）与持久运行时**：
  - 抽象 `PersistentRoomRuntime`，在路由流转时持久保活底层房间音频引擎与 AudioContext。
  - 用户暂离房间浏览大厅、画像或歌单时音频不中断，大厅与侧栏展示悬浮“返回房间”卡片。
- **发现页重构与全链路搜索整合**：
  - `/app/discover` 聚焦房间推荐与偏好探索。
  - 跨平台歌曲搜索深度融合进歌单与曲库导入流程，支持网易云、QQ 音乐与 B 站分 P 取流。
- **音频导入管线加固与内存防 OOM**：
  - 引入 Bounded Segment Encoding Queue 受限分段转码队列，严格限制转码并发。
  - 支持批量导入任务手动取消与超时熔断，彻底消除大文件与批量导入造成的浏览器 OOM 崩溃。
- **本地文件沙盒授权落地**：
  - 支持现代浏览器 File System Access API 目录授权与 Tauri 原生文件系统持久化存储。
- **播放队列与声学增强**：
  - 随机播放重构为 Fisher-Yates 洗牌算法，彻底避免短期内重复播放相同曲目。
  - 引入响度分析与自适应增益对齐（Loudness Normalization）。
  - 支持逐字精准高亮 YRC 歌词、双语对照、罗马音音译注音。
- **全面落实 Anti-AI-Slop 收敛克制设计规范**：
  - 全局根除 `--accent-glow` 与发光阴影类；移除卡片/按钮/分段控制器外发光。
  - 重构房间舞台几何声波与同心电波曲线；房间编辑菜单与交互弹窗采用 100% 实体高对比表面杜绝透底干扰；修复歌词译文高亮分离。
  - 全面统一 Radix UI Colors 配色与 0.5px 精细描边规范。

## 后续风险与观测

- 仍需在 CI 中持续运行双 Chromium context 的长时间 WebRTC 播放回归
- 需要采集真实设备上的 limiter peak、RMS、瞬时跃变和欠载恢复数据
- TURN 配置异常时跨网络媒体仍可能进入 `reconnecting`，但不应改变播放链路设计
- 多人听歌只认源成员分发的本地歌曲资产：源成员离线或资产未就绪时房间统一暂停，严禁各端偷跑播放；源成员上线后自动准备并恢复时钟。有 `player` 权限的成员可控制播放（默认 true）；房主拥有全部权限。服务端 watchdog 会在曲目超时未切歌时自动推进。
- 当前正式部署仍限制为单个 `server` 实例；多实例房间权威和事件顺序尚未完成生产验证
- 外部 provider 受上游登录态、接口、版权和可用音质影响，不是本地曲库的可靠替代
