"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowRight, Check, Copy, LayoutGrid, Lock } from "lucide-react";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { RoomDirectoryCard } from "@/components/room-card";
import { roomTypeDescription } from "./room-home-types";
import {
  formatRoomLiveMetric,
  isRoomActivelyPlaying,
  toSafeViewTransitionToken,
  type CuratedGalleryPlan
} from "./room-gallery-layout";

type RoomCuratedGalleryProps = {
  plan: CuratedGalleryPlan;
  roomsLoaded: boolean;
  awayRoomId: string | null;
  morphingStageRoomId: string | null;
  suppressCardSlotTransition?: boolean;
  onOpenRoom: (room: RoomDirectoryItem) => void;
  onQuickEnterRoom: (room: RoomDirectoryItem) => void;
  onPrewarmRoom: (roomId: string) => void;
};

export function RoomCuratedGallery({
  plan,
  roomsLoaded,
  awayRoomId,
  morphingStageRoomId,
  suppressCardSlotTransition = false,
  onOpenRoom,
  onQuickEnterRoom,
  onPrewarmRoom
}: RoomCuratedGalleryProps) {
  const galleryRootRef = useRef<HTMLDivElement>(null);

  function handleGalleryKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp"
    ) {
      return;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (activeElement.dataset.testid !== "room-directory-open") return;

    const root = galleryRootRef.current;
    if (!root) return;
    const triggers = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-testid="room-directory-open"]')
    );
    const currentIndex = triggers.indexOf(activeElement as HTMLButtonElement);
    if (currentIndex === -1 || triggers.length <= 1) return;

    event.preventDefault();
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + triggers.length) % triggers.length;
    triggers[nextIndex]?.focus();
  }

  function buildSlotStyle(roomId: string): CSSProperties | undefined {
    if (suppressCardSlotTransition) return undefined;
    return {
      viewTransitionName: `lobby-card-${toSafeViewTransitionToken(roomId)}`
    };
  }

  function resolveStageTransitionName(roomId: string): string | undefined {
    return morphingStageRoomId === roomId ? "active-room-stage" : undefined;
  }

  if (!plan.orderedRooms.length) {
    if (!roomsLoaded) {
      return (
        <div className="grid w-full grid-cols-1 gap-4 pt-1 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="flex flex-col gap-3 rounded-xl border-hairline border-surface-border bg-surface/40 p-3 animate-pulse"
            >
              <div className="w-full aspect-[2.4/1] rounded-lg bg-surface-hover/70" />
              <div className="h-4 w-2/5 rounded bg-surface-hover/70" />
              <div className="h-3 w-4/5 rounded bg-surface-hover/50" />
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="mx-auto flex min-h-[260px] max-w-[680px] flex-col items-center justify-center rounded-[20px] border-hairline border-surface-border bg-surface/35 px-6 py-14 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border-hairline border-surface-border bg-surface text-foreground-muted">
          <LayoutGrid className="h-5 w-5" />
        </div>
        <h2 className="mb-1.5 text-sm font-semibold text-foreground">当前没有房间</h2>
        <p className="max-w-xs text-xs leading-relaxed text-foreground-muted">
          可以先创建一个房间等待成员加入，或输入房间码进入私密房间。
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-4 md:gap-5"
      data-gallery-mode={plan.mode}
      onKeyDown={handleGalleryKeyDown}
      ref={galleryRootRef}
    >
      {/* Mode 1: Solo Exhibition Frame (N = 1) */}
      {plan.mode === "solo" && plan.leadRoom ? (
        <div className="mx-auto w-full max-w-[880px] pt-1 md:pt-3">
          <LeadStageShowcase
            awayRoomId={awayRoomId}
            item={plan.leadRoom}
            onOpen={() => onOpenRoom(plan.leadRoom!)}
            onPrewarm={() => onPrewarmRoom(plan.leadRoom!.room.id)}
            onQuickEnter={() => onQuickEnterRoom(plan.leadRoom!)}
            slotStyle={buildSlotStyle(plan.leadRoom.room.id)}
            stageTransitionName={resolveStageTransitionName(plan.leadRoom.room.id)}
          />
        </div>
      ) : null}

      {/* Mode 2: Balanced Diptych Frame (N = 2) */}
      {plan.mode === "diptych" && plan.diptychRooms ? (
        <div className="mx-auto grid w-full max-w-[920px] grid-cols-1 gap-4 pt-1 md:grid-cols-2 md:gap-5 md:pt-2">
          {plan.diptychRooms.map((item, index) => (
            <DiptychGalleryFrame
              awayRoomId={awayRoomId}
              isPrimary={index === 0}
              item={item}
              key={item.room.id}
              onOpen={() => onOpenRoom(item)}
              onPrewarm={() => onPrewarmRoom(item.room.id)}
              onQuickEnter={() => onQuickEnterRoom(item)}
              slotStyle={buildSlotStyle(item.room.id)}
              stageTransitionName={resolveStageTransitionName(item.room.id)}
            />
          ))}
        </div>
      ) : null}

      {/* Mode 3 & 4: Lead Stage Showcase + Paired Duet (N = 3) or Rhythm Matrix (N >= 4) */}
      {(plan.mode === "trio" || plan.mode === "gallery") && plan.leadRoom ? (
        <>
          <LeadStageShowcase
            awayRoomId={awayRoomId}
            item={plan.leadRoom}
            onOpen={() => onOpenRoom(plan.leadRoom!)}
            onPrewarm={() => onPrewarmRoom(plan.leadRoom!.room.id)}
            onQuickEnter={() => onQuickEnterRoom(plan.leadRoom!)}
            slotStyle={buildSlotStyle(plan.leadRoom.room.id)}
            stageTransitionName={resolveStageTransitionName(plan.leadRoom.room.id)}
          />

          {plan.mode === "trio" && plan.pairedSubRooms ? (
            <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
              {plan.pairedSubRooms.map((item) => (
                <div
                  className="min-w-0"
                  key={item.room.id}
                  style={buildSlotStyle(item.room.id)}
                >
                  <RoomDirectoryCard
                    onOpen={() => onOpenRoom(item)}
                    onPrewarm={() => onPrewarmRoom(item.room.id)}
                    room={item}
                    stageTransitionName={resolveStageTransitionName(item.room.id)}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {plan.mode === "gallery" && plan.matrixRooms.length > 0 ? (
            <div className="grid w-full grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:gap-4">
              {plan.matrixRooms.map((item) => (
                <div
                  className="min-w-0"
                  key={item.room.id}
                  style={buildSlotStyle(item.room.id)}
                >
                  <RoomDirectoryCard
                    onOpen={() => onOpenRoom(item)}
                    onPrewarm={() => onPrewarmRoom(item.room.id)}
                    room={item}
                    stageTransitionName={resolveStageTransitionName(item.room.id)}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function LeadStageShowcase({
  item,
  awayRoomId,
  slotStyle,
  stageTransitionName,
  onOpen,
  onQuickEnter,
  onPrewarm
}: {
  item: RoomDirectoryItem;
  awayRoomId: string | null;
  slotStyle?: CSSProperties;
  stageTransitionName?: string;
  onOpen: () => void;
  onQuickEnter: () => void;
  onPrewarm: () => void;
}) {
  const { room } = item;
  const isAway = Boolean(awayRoomId && awayRoomId === room.id);
  const isActive = isRoomActivelyPlaying(item);
  const liveMetric = formatRoomLiveMetric(item);
  const nowPlaying = room.directoryNowPlaying;

  const accessText = isAway
    ? "同步保持中"
    : room.directoryIsMember
      ? "已在房间中"
      : room.hasPassword
        ? "密码保护"
        : room.visibility === "private"
          ? "私密房间"
          : "公开直入";

  const actionLabel = isAway
    ? "回到房间"
    : room.hasPassword
      ? "解锁进入"
      : room.directoryIsMember
        ? "回到房间"
        : "进入房间";

  const programSummary = nowPlaying?.title
    ? nowPlaying.artist
      ? `${nowPlaying.title} / ${nowPlaying.artist}`
      : nowPlaying.title
    : roomTypeDescription(room.roomType);

  return (
    <div
      className={`grid w-full grid-cols-1 items-stretch gap-1.5 rounded-[20px] border-hairline p-2 transition-colors duration-[250ms] ease-out lg:grid-cols-[1.36fr_1fr] lg:gap-3 ${
        isAway
          ? "border-[var(--amber-6)] bg-[var(--amber-2)]"
          : "border-surface-border bg-surface/35"
      }`}
      style={slotStyle}
    >
      <div className="min-w-0">
        <RoomDirectoryCard
          onOpen={onOpen}
          onPrewarm={onPrewarm}
          room={item}
          stageTransitionName={stageTransitionName}
        />
      </div>

      {/* Desktop Curatorial Placard: unboxed surface with 0.5px hairline ledger */}
      <div className="hidden flex-col justify-between px-3.5 py-2.5 lg:flex">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                isAway
                  ? "bg-[var(--amber-9)]"
                  : isActive
                    ? "bg-[var(--green-9)]"
                    : "bg-[var(--slate-8)]"
              }`}
            />
            <span>{isAway ? "暂离同步中" : isActive ? "在播焦点现场" : "主展位房间"}</span>
          </span>

          <CopyableJoinCodeChip joinCode={room.joinCode} />
        </div>

        <dl className="my-2 border-y-[0.5px] border-surface-border/60 text-xs">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="shrink-0 text-foreground-muted">
              {nowPlaying?.title ? "正在播出" : "协作方式"}
            </dt>
            <dd className="truncate font-medium text-foreground">{programSummary}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t-[0.5px] border-surface-border/60 py-2.5">
            <dt className="shrink-0 text-foreground-muted">房主</dt>
            <dd className="truncate font-medium text-foreground">
              {room.directoryHostNickname || "未知"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t-[0.5px] border-surface-border/60 py-2.5">
            <dt className="shrink-0 text-foreground-muted">{liveMetric.label}</dt>
            <dd className="truncate font-mono tabular-nums text-foreground">
              {liveMetric.value}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t-[0.5px] border-surface-border/60 py-2.5">
            <dt className="shrink-0 text-foreground-muted">准入方式</dt>
            <dd className="inline-flex items-center gap-1 truncate font-medium text-foreground">
              {room.hasPassword ? <Lock className="h-3 w-3 shrink-0 text-foreground-muted" /> : null}
              <span className="truncate">{accessText}</span>
            </dd>
          </div>
        </dl>

        <div className="flex items-center justify-between gap-2">
          <button
            className="rounded-lg px-2 py-1.5 text-xs text-foreground-muted transition-colors duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground cursor-pointer"
            onClick={onOpen}
            onPointerEnter={onPrewarm}
            type="button"
          >
            展开门廊详情
          </button>

          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-xs font-medium text-white transition-colors duration-[250ms] ease-out hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
            onClick={onQuickEnter}
            onPointerEnter={onPrewarm}
            type="button"
          >
            <span>{actionLabel}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Mobile Compact Stage Plinth: single sleek footer strip keeping next cards in viewport */}
      <div className="flex items-center justify-between gap-2 px-1.5 pt-0.5 pb-0.5 text-xs lg:hidden">
        <div className="flex min-w-0 items-center gap-1.5 truncate text-foreground-muted">
          {isAway ? (
            <span className="font-medium text-[var(--amber-11)]">暂离同步中</span>
          ) : (
            <>
              <span className="truncate">房主 {room.directoryHostNickname || "未知"}</span>
              <span aria-hidden="true" className="opacity-45">/</span>
              <span className="shrink-0 font-mono tabular-nums">{liveMetric.value}</span>
            </>
          )}
        </div>

        <button
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-accent px-3 text-xs font-medium text-white transition-colors duration-[250ms] ease-out hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
          onClick={onQuickEnter}
          onPointerEnter={onPrewarm}
          type="button"
        >
          <span>{actionLabel}</span>
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function DiptychGalleryFrame({
  item,
  awayRoomId,
  isPrimary,
  slotStyle,
  stageTransitionName,
  onOpen,
  onQuickEnter,
  onPrewarm
}: {
  item: RoomDirectoryItem;
  awayRoomId: string | null;
  isPrimary: boolean;
  slotStyle?: CSSProperties;
  stageTransitionName?: string;
  onOpen: () => void;
  onQuickEnter: () => void;
  onPrewarm: () => void;
}) {
  const { room } = item;
  const isAway = Boolean(awayRoomId && awayRoomId === room.id);
  const liveMetric = formatRoomLiveMetric(item);
  const actionLabel = isAway
    ? "回到房间"
    : room.hasPassword
      ? "解锁进入"
      : room.directoryIsMember
        ? "回到房间"
        : "进入房间";

  return (
    <div
      className={`flex flex-col justify-between rounded-[20px] border-hairline p-2 transition-colors duration-[250ms] ease-out ${
        isAway
          ? "border-[var(--amber-6)] bg-[var(--amber-2)]"
          : isPrimary
            ? "border-surface-border bg-surface/40"
            : "border-surface-border bg-surface/20"
      }`}
      style={slotStyle}
    >
      <div className="min-w-0 flex-1">
        <RoomDirectoryCard
          onOpen={onOpen}
          onPrewarm={onPrewarm}
          room={item}
          stageTransitionName={stageTransitionName}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 px-1.5 py-0.5 text-xs">
        <div className="flex min-w-0 items-center gap-1.5 truncate text-foreground-muted">
          {isAway ? (
            <span className="font-medium text-[var(--amber-11)]">暂离同步中</span>
          ) : (
            <>
              <span className="truncate">房主 {room.directoryHostNickname || "未知"}</span>
              <span aria-hidden="true" className="opacity-45">/</span>
              <span className="shrink-0 font-mono tabular-nums">{liveMetric.value}</span>
            </>
          )}
        </div>

        <button
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border-hairline border-surface-border bg-background-secondary px-2.5 text-xs font-medium text-foreground transition-colors duration-[250ms] ease-out hover:border-accent hover:text-accent active:scale-[0.98] cursor-pointer"
          onClick={onQuickEnter}
          onPointerEnter={onPrewarm}
          type="button"
        >
          <span>{actionLabel}</span>
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function CopyableJoinCodeChip({ joinCode }: { joinCode: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(joinCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard failures in restricted webviews.
    }
  }

  return (
    <button
      aria-label={`复制房间码 ${joinCode}`}
      className="inline-flex h-6 items-center gap-1.5 rounded-md border-hairline border-surface-border bg-surface px-2 font-mono text-xs tabular-nums text-foreground-muted transition-colors duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground cursor-pointer"
      onClick={() => void handleCopy()}
      title="点击复制房间码"
      type="button"
    >
      <span>{copied ? "已复制" : joinCode}</span>
      {copied ? (
        <Check className="h-3 w-3 text-[var(--green-11)]" />
      ) : (
        <Copy className="h-3 w-3 opacity-70" />
      )}
    </button>
  );
}
