import Link from "next/link";
import type { Route } from "next";

import { TopBar } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { buildAppEntryHref } from "@/lib/domain/client-shell";
import {
  LaptopIcon,
  MusicIcon,
  FolderIcon
} from "@/components/icons/DiscoverIcons";

const githubRepositoryUrl = "https://github.com/witw123/soqaro";

/**
 * Three distinct room collaboration modes
 */
const roomModes = [
  {
    type: "standard",
    title: "标准协作房",
    subtitle: "Standard Collaborative Room",
    badge: "全员共建",
    badgeTone: "border-blue-500/30 bg-blue-500/10 text-blue-400",
    description: "适合好友小聚、团队听歌与共同构建曲库。房间成员共享同一条播放队列，授权成员均可自由点歌、切歌与调整排队顺序，播放状态毫秒级无感知对齐。",
    highlights: [
      "共享实时播放队列，全员同步更新",
      "细粒度播控权限分配，保障房间秩序",
      "无感知毫秒级时钟对齐与瞬时同步"
    ]
  },
  {
    type: "request",
    title: "点歌点播房",
    subtitle: "Request / Inbox Room",
    badge: "主理把控",
    badgeTone: "border-purple-500/30 bg-purple-500/10 text-purple-400",
    description: "专为主播聚会、歌友互动与主题派对打造。主理人牢牢把控核心播放流，听众搜索曲库并提交点歌申请至专属待办箱，由房主一键审批入队或置顶插播。",
    highlights: [
      "专属点歌待办箱，主理人一键审核",
      "支持置顶插播与有序排队播放",
      "听众随时探索多源曲库发起点播"
    ]
  },
  {
    type: "radio",
    title: "自由电台房",
    subtitle: "Radio / On-Air Broadcast",
    badge: "广播策展",
    badgeTone: "border-teal-500/30 bg-teal-500/10 text-teal-400",
    description: "适合个人音乐广播、深夜声波漫游与策展分享。房主独占播控权并开启自动续播探索，全员沉浸在连续不间断的流动声波中，支持实时打 Call 互动互动。",
    highlights: [
      "主理人广播策展，智能自动续播",
      "轻量打 Call 浮动粒子实时同屏反馈",
      "极简广播流，专注声学氛围沉浸"
    ]
  }
];

/**
 * Real technical architecture and pipeline stages
 */
const architectureStages = [
  {
    step: "01",
    label: "本地资产与分段转码",
    role: "客户端本地沙盒 (Client Storage)",
    description: "用户的本地无损音频（FLAC / WAV / MP3 / Ogg）或第三方平台导入曲目在浏览器端完成分段 Opus 预编码，写入 IndexedDB 本地沙盒。音频源文件 100% 留在本机，零上传至服务器。",
    tags: ["IndexedDB 缓存", "本地分段 Opus", "零云端上传"]
  },
  {
    step: "02",
    label: "权威房间状态与信令中心",
    role: "服务端协同 (NestJS + Socket.IO)",
    description: "服务端负责维护权威播放基准时钟（startAt）、成员在线感知、播放权限调度与队列排队状态。服务端仅保存房间元数据与协同信令，不中继、不解析、不截留任何音频数据。",
    tags: ["毫秒级基准时钟", "Socket.IO 双工信令", "无音频沉淀"]
  },
  {
    step: "03",
    label: "WebRTC RTP Opus 实时广播",
    role: "点对点媒体传输 (WebRTC Media Stream)",
    description: "曲目拥有者作为单一广播源，向房间成员建立低延迟 WebRTC 媒体通道，直接推流 48kHz 高保真 RTP Opus 音频。避免成员间互传庞大原始文件，节约带宽且实时响应。",
    tags: ["48kHz 高保真", "单一广播源", "弱网丢包补偿"]
  },
  {
    step: "04",
    label: "听众端单一输出总线播放",
    role: "监听端渲染 (AudioContext Pipeline)",
    description: "监听端接收单一 RTP 媒体流，通过共享 AudioContext 统一调度播放，全员保持精准声学对齐。拥有者离线时本地曲目静默暂停，第三方曲目支持端侧自动回退继续播放。",
    tags: ["共享 AudioContext", "毫秒级同步", "离线静默容灾"]
  }
];

/**
 * Ecosystem capabilities (Lyrics, Multi-Client, Hybrid Library)
 */
const ecosystemCards = [
  {
    icon: MusicIcon,
    title: "全景精准歌词系统",
    description: "支持标准 LRC 滚动歌词与网易云 YRC 逐字动效（Word-by-Word）。提供双语对照翻译与罗马音发音标注，移动端支持一触全屏沉浸歌词，桌面端支持系统级悬浮窗口置顶显示。"
  },
  {
    icon: FolderIcon,
    title: "本地与在线多源曲库打通",
    description: "原生支持本地音频文件与整个文件夹批量导入（借助 File System Access API 自动监听）。无缝打通网易云音乐与 QQ 音乐账号绑定、曲目搜索、歌单导入与专辑收藏。"
  },
  {
    icon: LaptopIcon,
    title: "全平台多端原生支持",
    description: "响应式 Web 网页端随时开箱即用；Tauri 2 桌面端极小体积占用，深度集成 Windows SMTC 系统快捷键；Capacitor 7 移动端集成原生 Android MediaSession 后台播放服务与锁屏控制。"
  }
];

export function ProductLandingPage() {
  const appHref = buildAppEntryHref();

  return (
    <main className="relative min-h-[calc(100*var(--app-dvh))] bg-[#090a0f] text-foreground font-sans selection:bg-accent/30 selection:text-white">
      <a className="skip-link" href="#landing-main">跳到主要内容</a>

      {/* Navigation TopBar */}
      <TopBar activeSession={null} variant="marketing" />

      {/* Subtle Background Grid */}
      <div aria-hidden="true" className="fixed inset-0 -z-10 pointer-events-none bg-[#090a0f]">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
      </div>

      {/* Hero Section */}
      <section id="landing-main" tabIndex={-1} className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pt-16 pb-20 text-center outline-none sm:px-6 sm:pt-24 sm:pb-24">
        {/* Eyebrow badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1 text-xs font-medium text-white/80">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="flex items-center gap-2.5">
            <span>开源</span>
            <span className="text-white/30">/</span>
            <span>本地优先</span>
            <span className="text-white/30">/</span>
            <span>WebRTC 低延迟同步</span>
          </span>
        </div>

        {/* Headline */}
        <h1 className="max-w-4xl text-3xl font-extrabold tracking-tight text-white sm:text-5xl md:text-6xl leading-[1.12]">
          与好友实时同步收听音乐
          <span className="block text-white/60 font-semibold mt-2 text-2xl sm:text-4xl md:text-5xl">
            音频资产全程留在本地
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-6 max-w-2xl text-sm sm:text-base leading-relaxed text-white/65">
          Soqaro 是一款开源的多端协作听歌平台。采用 WebRTC RTP Opus 媒体流传输与房间状态机对齐，实现毫秒级同频收听。无需将私有音频文件上传至云端服务器，保护个人曲库隐私。
        </p>

        {/* Action CTAs */}
        <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
          <Link href={appHref as Route}>
            <Button
              size="lg"
              className="w-full sm:w-auto h-11 px-6 rounded-xl text-sm font-semibold bg-accent hover:bg-accent-hover text-white shadow-xs"
            >
              进入房间大厅
            </Button>
          </Link>

          <Link href={githubRepositoryUrl} target="_blank" rel="noreferrer">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-11 px-6 rounded-xl text-sm font-medium border-white/15 bg-white/[0.03] text-white hover:bg-white/[0.08]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="mr-2">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              GitHub 源码
            </Button>
          </Link>

          <Link href="#architecture">
            <Button
              size="lg"
              variant="ghost"
              className="w-full sm:w-auto h-11 px-5 rounded-xl text-sm font-medium text-white/70 hover:text-white hover:bg-white/[0.05]"
            >
              技术架构
            </Button>
          </Link>
        </div>
      </section>

      {/* Real Architecture & Data Pipeline Section */}
      <section id="architecture" className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
        <div className="mb-8 text-center sm:text-left">
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            端到端声学架构：本地优先，零云端音频留存
          </h2>
          <p className="mt-2 text-sm text-white/60 max-w-3xl leading-relaxed">
            曲目拥有者作为单一音频广播源，直接向房间成员推流。服务端只负责权威信令协同与播放快照，不中继、不截留任何私有音频文件。
          </p>
        </div>

        {/* Architecture Flow Timeline Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {architectureStages.map((stage) => (
            <div
              key={stage.step}
              className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 shadow-xs transition-colors hover:border-white/15"
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="font-mono text-xs font-bold text-accent px-2 py-0.5 rounded-md bg-accent/10 border border-accent/20">
                    STAGE {stage.step}
                  </span>
                  <span className="text-xs font-mono text-white/40">{stage.role}</span>
                </div>
                <h3 className="text-base font-semibold text-white tracking-tight">
                  {stage.label}
                </h3>
                <p className="mt-2.5 text-xs text-white/60 leading-relaxed">
                  {stage.description}
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex flex-wrap gap-1.5">
                {stage.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-block rounded-md bg-white/[0.04] px-2 py-0.5 text-xs font-medium text-white/50"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Audio Flow Diagram Callout */}
        <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-xs font-mono text-white/70 overflow-x-auto hide-scrollbar">
          <p className="text-xs font-bold text-white/50 mb-2 font-sans">
            权威音频传输链路（Single-Source Broadcast Path）
          </p>
          <div className="flex items-center gap-2 whitespace-nowrap text-white/80">
            <span className="text-accent font-semibold">IndexedDB 本地分段 Opus</span>
            <span className="text-white/30">→</span>
            <span>SegmentedOpusEngine</span>
            <span className="text-white/30">→</span>
            <span>共享 AudioContext 总线</span>
            <span className="text-white/30">→</span>
            <span className="text-emerald-400 font-semibold">WebRTC RTP Opus 广播</span>
            <span className="text-white/30">→</span>
            <span>听众单一 audio.srcObject 极速输出</span>
          </div>
        </div>
      </section>

      {/* Room Modes Section */}
      <section id="room-modes" className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6">
        <div className="mb-8 text-center sm:text-left">
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            为真实音乐社交场景定制的房间形态
          </h2>
          <p className="mt-2 text-sm text-white/60 max-w-2xl leading-relaxed">
            不同的听歌场景需要截然不同的权限与交互逻辑。Soqaro 提供了三种经过严谨打磨的房间类型。
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {roomModes.map((mode) => (
            <article
              key={mode.type}
              className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 shadow-xs hover:border-white/15 transition-colors"
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${mode.badgeTone}`}>
                    {mode.badge}
                  </span>
                  <span className="text-xs font-mono text-white/40">{mode.subtitle}</span>
                </div>
                <h3 className="text-lg font-bold text-white tracking-tight">
                  {mode.title}
                </h3>
                <p className="mt-3 text-xs text-white/65 leading-relaxed">
                  {mode.description}
                </p>
              </div>

              <div className="mt-6 pt-4 border-t border-white/[0.06] space-y-2">
                {mode.highlights.map((item) => (
                  <div key={item} className="flex items-start gap-2 text-xs text-white/70">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Core Ecosystem & Capabilities */}
      <section id="features" className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
        <div className="mb-8 text-center sm:text-left">
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            完整的现代数字音乐体验
          </h2>
          <p className="mt-2 text-sm text-white/60 max-w-2xl leading-relaxed">
            不仅是多人同步，从逐字歌词、多源曲库融合到跨平台原生媒体控制，每一个细节都精细调校。
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {ecosystemCards.map((card) => {
            const IconComponent = card.icon;
            return (
              <div
                key={card.title}
                className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 shadow-xs hover:border-white/15 transition-colors"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] border border-white/[0.08] text-accent mb-4">
                  <IconComponent className="h-4.5 w-4.5" />
                </div>
                <h3 className="text-base font-bold text-white tracking-tight">
                  {card.title}
                </h3>
                <p className="mt-2.5 text-xs sm:text-sm text-white/60 leading-relaxed">
                  {card.description}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Quick Start & Self-Hosting Guide */}
      <section id="self-host" className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <h3 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                完全开源，支持自主搭建与私有部署
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-white/60 leading-relaxed">
                代码仓库采用标准 pnpm monorepo 组织，服务端基于 NestJS + PostgreSQL + Redis，搭配标准 coturn WebRTC 中继即可轻松完成私有化部署。
              </p>
            </div>

            <div className="flex shrink-0 gap-3">
              <Link href={appHref as Route}>
                <Button className="h-10 px-5 rounded-xl text-xs font-semibold bg-accent hover:bg-accent-hover text-white shadow-xs">
                  直接体验
                </Button>
              </Link>
              <Link href={githubRepositoryUrl} target="_blank" rel="noreferrer">
                <Button variant="outline" className="h-10 px-5 rounded-xl text-xs font-medium border-white/15 bg-white/[0.03] text-white hover:bg-white/[0.08]">
                  查看 README 部署文档
                </Button>
              </Link>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-white/[0.08] bg-black/40 p-4 font-mono text-xs text-white/80 overflow-x-auto hide-scrollbar">
            <div className="text-white/40 select-none mb-1"># 快速本地启动 Monorepo 全栈工作区</div>
            <div className="text-emerald-400">git clone https://github.com/witw123/soqaro.git</div>
            <div>cd soqaro && pnpm install</div>
            <div className="text-accent">pnpm dev</div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.08] bg-[#07080c] py-10">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white shadow-xs">
              <MusicIcon className="w-3.5 h-3.5" />
            </div>
            <span className="font-bold text-sm text-white tracking-tight">Soqaro</span>
            <span className="text-xs text-white/40">开源多人协作同步听歌平台</span>
          </div>

          <p className="text-xs text-white/40">
            &copy; {new Date().getFullYear()} Soqaro Contributors. Open source under MIT License.
          </p>

          <div className="flex items-center gap-5 text-xs text-white/60">
            <Link
              href={githubRepositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              GitHub 仓库
            </Link>
            <Link
              href={`${githubRepositoryUrl}#documentation`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              架构文档
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
