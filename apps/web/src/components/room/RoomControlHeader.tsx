"use client";

import { useState, type FormEvent, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { getNewMemberPermissions } from "@soqaro/shared";
import type {
  RoomMember,
  RoomSnapshot,
  UpdateRoomRequest
} from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import {
  CopyIcon,
  MoreVerticalIcon,
  MusicIcon,
  RadioIcon,
  ShareIcon,
  UsersIcon
} from "@/components/icons/DiscoverIcons";
import { MemberPermissionControls } from "./MembersPanel";

function buildRoomEditForm(roomSnapshot: RoomSnapshot): UpdateRoomRequest {
  return {
    visibility: roomSnapshot.room.visibility,
    name: roomSnapshot.room.name ?? "",
    description: roomSnapshot.room.description ?? "",
    password: "",
    newMemberPermissions: getNewMemberPermissions(roomSnapshot.room)
  };
}

export type RoomControlHeaderProps = {
  roomSnapshot: RoomSnapshot;
  host?: RoomMember;
  canDeleteRoom?: boolean;
  canDisbandRoom?: boolean;
  onCopyJoinCode?: () => Promise<void> | void;
  onShareRoom?: () => Promise<void> | void;
  onAwayRoom?: () => void;
  onLeaveRoom?: () => Promise<void> | void;
  onDeleteRoom?: () => Promise<void> | void;
  onUpdateRoom?: (input: UpdateRoomRequest) => Promise<boolean>;
  hideRoomMetadata?: boolean;
  className?: string;
  isMobile?: boolean;
  centerContent?: React.ReactNode;
};

export function RoomControlHeader({
  roomSnapshot,
  host: propHost,
  canDeleteRoom = false,
  canDisbandRoom = false,
  onCopyJoinCode,
  onShareRoom,
  onAwayRoom,
  onLeaveRoom,
  onDeleteRoom,
  onUpdateRoom,
  hideRoomMetadata = false,
  className = "",
  isMobile = false,
  centerContent
}: RoomControlHeaderProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [isDeletingRoom, setIsDeletingRoom] = useState(false);
  const [showEditRoom, setShowEditRoom] = useState(false);
  const [isUpdatingRoom, setIsUpdatingRoom] = useState(false);
  const [editRoomForm, setEditRoomForm] = useState<UpdateRoomRequest>(() =>
    buildRoomEditForm(roomSnapshot)
  );
  const [isCopying, setIsCopying] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const host = propHost ?? roomSnapshot.room.members.find(
    (member) => member.id === roomSnapshot.room.hostId || member.role === "host"
  );
  const onlineMemberCount = roomSnapshot.room.members.filter(
    (member) => member.presenceState !== "offline"
  ).length;

  const handleCopyJoinCode = async () => {
    if (isCopying || !onCopyJoinCode) return;
    setIsCopying(true);
    try {
      await onCopyJoinCode();
    } finally {
      window.setTimeout(() => setIsCopying(false), 1200);
    }
  };

  const handleShareRoom = async () => {
    if (isSharing || !onShareRoom) return;
    setIsSharing(true);
    try {
      await onShareRoom();
    } finally {
      window.setTimeout(() => setIsSharing(false), 1200);
    }
  };

  const handleDeleteRoom = async () => {
    if (!onDeleteRoom) return;
    setIsDeletingRoom(true);
    try {
      await onDeleteRoom();
      setShowDeleteConfirmation(false);
    } finally {
      setIsDeletingRoom(false);
    }
  };

  const openEditRoom = () => {
    setEditRoomForm(buildRoomEditForm(roomSnapshot));
    setShowSettings(false);
    setShowEditRoom(true);
  };

  const handleUpdateRoom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onUpdateRoom || isUpdatingRoom || !editRoomForm.name.trim()) return;
    setIsUpdatingRoom(true);
    try {
      const updated = await onUpdateRoom({
        visibility: editRoomForm.visibility,
        name: editRoomForm.name.trim(),
        description: editRoomForm.description?.trim() || null,
        password: editRoomForm.password?.trim() ?? "",
        ...(roomSnapshot.room.roomType === "interactive"
          ? { newMemberPermissions: editRoomForm.newMemberPermissions }
          : {})
      });
      if (updated) setShowEditRoom(false);
    } finally {
      setIsUpdatingRoom(false);
    }
  };

  const roomType = roomSnapshot.room.roomType;
  const roomTypeConfig = roomType === "radio"
    ? { label: "电台广播", icon: RadioIcon }
    : roomType === "request"
    ? { label: "点歌互动", icon: MusicIcon }
    : { label: "共听互动", icon: UsersIcon };
  const RoomTypeIcon = roomTypeConfig.icon;

  if (isMobile) {
    return (
      <>
        {/* Mobile Streamlined Room Control Header */}
        <div className={`flex w-full flex-col gap-1.5 ${className}`}>
          {/* Row 1: Room Name (flex-1 truncate) + Action Buttons (shrink-0) */}
          <div className="flex w-full items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">
                {roomSnapshot.room.name || "当前房间"}
              </h1>
              {roomSnapshot.room.visibility === "private" ? (
                <span className="shrink-0 text-amber-500/90" title="私密房间">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
              ) : null}
            </div>

            {/* Mobile Right Actions: Share + Settings */}
            <div className="flex items-center gap-1.5 shrink-0">
              {onShareRoom ? (
                <button
                  data-testid="mobile-share-room-button"
                  aria-label="分享房间"
                  className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-surface-border/70 bg-surface/80 px-2 text-xs font-medium text-foreground-muted hover:text-foreground active:scale-95 transition-transform"
                  disabled={isSharing}
                  onClick={() => void handleShareRoom()}
                  type="button"
                >
                  <ShareIcon className="w-3 h-3" />
                  <span>{isSharing ? "已复制" : "分享"}</span>
                </button>
              ) : null}

              <div className="relative pointer-events-auto">
                <Button
                  data-testid="mobile-room-settings-button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-full border border-surface-border/70 bg-surface/80 text-foreground-muted hover:text-foreground active:scale-95 transition-transform"
                  onClick={() => setShowSettings((value) => !value)}
                  type="button"
                >
                  <MoreVerticalIcon className="w-3.5 h-3.5" />
                </Button>

                {showSettings && typeof document !== "undefined"
                  ? createPortal(
                      <div
                        className="fixed inset-0 z-[var(--z-modal)] flex flex-col justify-end bg-black/60 backdrop-blur-xs animate-fade-in"
                        onClick={() => setShowSettings(false)}
                        role="presentation"
                      >
                        <div
                          aria-label="房间快捷操作"
                          className="w-full max-w-lg mx-auto rounded-t-2xl border-t border-surface-border bg-background-secondary p-3.5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl animate-slide-up flex flex-col gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                          role="menu"
                        >
                          <div className="flex items-center justify-between px-3 py-1.5 border-b border-surface-border/50 mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate text-xs font-semibold text-foreground">
                                {roomSnapshot.room.name || "当前房间"}
                              </span>
                              <span className="text-xs text-foreground-muted font-mono">
                                #{roomSnapshot.room.joinCode}
                              </span>
                            </div>
                            <button
                              aria-label="关闭操作面板"
                              className="text-xs text-foreground-muted hover:text-foreground p-1 cursor-pointer"
                              onClick={() => setShowSettings(false)}
                              type="button"
                            >
                              ✕
                            </button>
                          </div>

                          {canDeleteRoom && onUpdateRoom ? (
                            <button
                              data-testid="mobile-edit-room-button"
                              className="w-full flex items-center justify-start rounded-xl px-3.5 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover active:bg-surface-hover cursor-pointer"
                              onClick={openEditRoom}
                              type="button"
                            >
                              编辑房间
                            </button>
                          ) : null}

                          {onAwayRoom ? (
                            <button
                              data-testid="mobile-away-room-button"
                              className="w-full flex items-center justify-start rounded-xl px-3.5 py-2.5 text-xs font-medium text-amber-500 transition-colors hover:bg-amber-500/10 active:bg-amber-500/10 cursor-pointer"
                              onClick={() => {
                                setShowSettings(false);
                                onAwayRoom();
                              }}
                              type="button"
                            >
                              暂离房间
                            </button>
                          ) : null}

                          <button
                            data-testid="mobile-leave-room-button"
                            className="w-full flex items-center justify-start rounded-xl px-3.5 py-2.5 text-xs font-medium text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-hover cursor-pointer"
                            onClick={() => {
                              setShowSettings(false);
                              void onLeaveRoom?.();
                            }}
                            type="button"
                          >
                            离开房间
                          </button>

                          {(canDeleteRoom || canDisbandRoom) && onDeleteRoom ? (
                            <button
                              data-testid="mobile-delete-room-button"
                              className="w-full flex items-center justify-start rounded-xl px-3.5 py-2.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 active:bg-red-500/10 cursor-pointer"
                              onClick={() => {
                                setShowSettings(false);
                                setShowDeleteConfirmation(true);
                              }}
                              type="button"
                            >
                              解散房间
                            </button>
                          ) : null}

                          <button
                            className="mt-1 w-full flex items-center justify-center rounded-xl bg-surface/80 py-2 text-xs font-medium text-foreground-muted hover:bg-surface-hover hover:text-foreground transition-colors cursor-pointer"
                            onClick={() => setShowSettings(false)}
                            type="button"
                          >
                            取消
                          </button>
                        </div>
                      </div>,
                      document.body
                    )
                  : null}
              </div>
            </div>
          </div>

          {/* Row 2: Metadata (Room Type, Join Code, Member Count, Host) */}
          <div className="flex w-full items-center gap-1.5 min-w-0 flex-wrap text-xs">
            <div className="flex items-center gap-1 rounded-full bg-accent/10 border border-accent/25 px-2 py-0.5 font-semibold text-accent shrink-0">
              <RoomTypeIcon className="w-3 h-3 shrink-0" />
              <span>{roomTypeConfig.label}</span>
            </div>

            <button
              data-testid="mobile-room-code-button"
              aria-label="复制房间码"
              className="group flex items-center gap-1.5 rounded-full border border-surface-border/70 bg-surface/80 px-2 py-0.5 font-mono font-bold tracking-wider text-foreground hover:bg-surface-hover active:scale-95 transition-all shrink-0 cursor-pointer"
              disabled={isCopying || !onCopyJoinCode}
              onClick={() => void handleCopyJoinCode()}
              type="button"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
              <span>{roomSnapshot.room.joinCode}</span>
              <CopyIcon className="w-2.5 h-2.5 text-foreground-muted shrink-0" />
              {isCopying ? <span className="text-xs font-sans font-medium text-accent">已复制</span> : null}
            </button>

            <span className="flex items-center gap-0.5 text-foreground-muted shrink-0">
              <UsersIcon className="w-3 h-3" />
              <span data-testid="mobile-online-member-count">{onlineMemberCount}</span>
              <span className="text-xs text-foreground-muted/70">在线</span>
            </span>

            {host ? (
              <span className="text-xs text-foreground-muted truncate max-w-[130px]">
                房主 {host.nickname}
              </span>
            ) : null}
          </div>
        </div>

        <ConfirmDialog
          confirmLabel="解散房间"
          description="房间、队列和共享曲库状态将被删除，所有成员都会离开。此操作无法撤销。"
          destructive
          onCancel={() => setShowDeleteConfirmation(false)}
          onConfirm={() => void handleDeleteRoom()}
          open={showDeleteConfirmation}
          pending={isDeletingRoom}
          title="确认解散房间？"
        />

        {onUpdateRoom ? (
          <RoomEditDialog
            form={editRoomForm}
            roomType={roomSnapshot.room.roomType}
            onChange={setEditRoomForm}
            onClose={() => {
              if (!isUpdatingRoom) setShowEditRoom(false);
            }}
            onSubmit={handleUpdateRoom}
            open={showEditRoom}
            pending={isUpdatingRoom}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {/* Desktop Fused Cockpit Bar */}
      <div className={`flex w-full items-center justify-between gap-3 h-11 sm:h-12 ${className}`}>
        {hideRoomMetadata ? null : (
          <div className="flex items-center gap-2.5 min-w-0 shrink-0">
            {/* Room Type Tag */}
            <div className="flex items-center gap-1.5 rounded-full bg-accent/10 border border-accent/25 px-2.5 py-1 text-xs font-semibold text-accent shrink-0 select-none">
              <RoomTypeIcon className="w-3.5 h-3.5 shrink-0" />
              <span>{roomTypeConfig.label}</span>
            </div>

            {/* Room Code Button */}
            <button
              data-testid="room-code-button"
              aria-label="复制房间码"
              className="group flex items-center gap-2 rounded-full border border-surface-border/70 bg-surface/70 px-2.5 py-1 text-xs font-mono font-bold tracking-wider text-foreground hover:bg-surface-hover hover:border-surface-border transition-colors cursor-pointer shrink-0 shadow-xs"
              disabled={isCopying || !onCopyJoinCode}
              onClick={() => void handleCopyJoinCode()}
              type="button"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span>{roomSnapshot.room.joinCode}</span>
              <CopyIcon className="w-3 h-3 text-foreground-muted group-hover:text-foreground shrink-0" />
              {isCopying ? <span className="text-xs font-sans font-medium text-accent">已复制</span> : null}
            </button>

            {/* Separator */}
            <span className="h-3.5 w-px bg-surface-border/60 shrink-0" />

            {/* Room Status Metadata */}
            <div className="flex items-center gap-2.5 text-xs text-foreground-muted truncate shrink-0">
              <span className="flex items-center gap-1">
                <UsersIcon className="w-3.5 h-3.5 shrink-0" />
                <span data-testid="online-member-count">{onlineMemberCount}</span>
                <span>人在线</span>
              </span>
              <span className="text-surface-border">/</span>
              <span>{roomSnapshot.room.visibility === "public" ? "公开" : "私密"}</span>
              {host ? (
                <>
                  <span className="text-surface-border">/</span>
                  <span className="truncate max-w-[7.5rem]" title={host.nickname}>房主 {host.nickname}</span>
                </>
              ) : null}
            </div>
          </div>
        )}

        {/* Center Slot (Integrated On-Air Media Console) */}
        {centerContent ? (
          <div className="flex min-w-0 flex-1 justify-center px-3">
            {centerContent}
          </div>
        ) : null}

        {/* Right Action Hub */}
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {onShareRoom ? (
            <button
              data-testid="share-room-button"
              aria-label="分享房间"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-surface-border/70 bg-surface/70 px-3 text-xs font-semibold text-foreground-muted shadow-xs transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-wait disabled:opacity-60"
              disabled={isSharing}
              onClick={() => void handleShareRoom()}
              title="分享房间"
              type="button"
            >
              <ShareIcon className="w-3.5 h-3.5 shrink-0" />
              <span>{isSharing ? "已复制" : "分享房间"}</span>
            </button>
          ) : null}

          <div className="relative pointer-events-auto">
            <Button
              data-testid="room-settings-button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full border border-surface-border/70 bg-surface/70 text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              onClick={() => setShowSettings((value) => !value)}
              type="button"
            >
              <MoreVerticalIcon className="w-4 h-4" />
            </Button>

            {showSettings ? (
              <>
                <div
                  className="fixed inset-0 z-[65]"
                  onClick={() => setShowSettings(false)}
                />
                <div className="animate-fade-in absolute right-0 top-10 z-[70] flex w-56 origin-top-right flex-col rounded-2xl border border-surface-border bg-background-secondary p-1.5 shadow-2xl">
                  {canDeleteRoom && onUpdateRoom ? (
                    <button
                      data-testid="edit-room-button"
                      className="w-full cursor-pointer rounded-xl px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      onClick={openEditRoom}
                      type="button"
                    >
                      编辑房间
                    </button>
                  ) : null}
                  {onAwayRoom ? (
                    <button
                      data-testid="away-room-button"
                      className="w-full cursor-pointer rounded-xl px-3 py-2.5 text-left text-sm text-amber-500 transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
                      onClick={() => {
                        setShowSettings(false);
                        onAwayRoom();
                      }}
                      type="button"
                    >
                      暂离房间
                    </button>
                  ) : null}
                  <button
                    data-testid="leave-room-button"
                    className="w-full cursor-pointer rounded-xl px-3 py-2.5 text-left text-sm text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => {
                      setShowSettings(false);
                      void onLeaveRoom?.();
                    }}
                    type="button"
                  >
                    离开房间
                  </button>
                  {(canDeleteRoom || canDisbandRoom) && onDeleteRoom ? (
                    <button
                      data-testid="delete-room-button"
                      className="my-1 w-full cursor-pointer rounded-xl px-3 py-2.5 text-left text-sm text-red-500 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
                      onClick={() => {
                        setShowSettings(false);
                        setShowDeleteConfirmation(true);
                      }}
                      title="解散房间"
                      type="button"
                    >
                      解散房间
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog
        confirmLabel="解散房间"
        description="房间、队列和共享曲库状态将被删除，所有成员都会离开。此操作无法撤销。"
        destructive
        onCancel={() => setShowDeleteConfirmation(false)}
        onConfirm={() => void handleDeleteRoom()}
        open={showDeleteConfirmation}
        pending={isDeletingRoom}
        title="确认解散房间？"
      />

      {onUpdateRoom ? (
        <RoomEditDialog
          form={editRoomForm}
          roomType={roomSnapshot.room.roomType}
          onChange={setEditRoomForm}
          onClose={() => {
            if (!isUpdatingRoom) setShowEditRoom(false);
          }}
          onSubmit={handleUpdateRoom}
          open={showEditRoom}
          pending={isUpdatingRoom}
        />
      ) : null}
    </>
  );
}

export function RoomEditDialog({
  form,
  roomType,
  onChange,
  onClose,
  onSubmit,
  open,
  pending
}: {
  form: UpdateRoomRequest;
  roomType: RoomSnapshot["room"]["roomType"];
  onChange: Dispatch<SetStateAction<UpdateRoomRequest>>;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  open: boolean;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !pending && onClose()}>
      <DialogContent className="max-w-lg p-5 sm:p-6">
        <DialogHeader className="pr-6">
          <DialogTitle id="edit-room-dialog-title" className="text-xl font-semibold text-foreground">
            编辑房间
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-sm leading-6 text-foreground-muted">
            修改房间信息后立即同步给当前成员。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <div
            className="flex gap-2 rounded-xl border border-surface-border bg-surface p-1"
            role="tablist"
            aria-label="房间可见性"
          >
            {(["public", "private"] as const).map((visibility) => (
              <button
                aria-selected={form.visibility === visibility}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  form.visibility === visibility
                    ? "bg-accent text-white"
                    : "text-foreground-muted hover:bg-surface-hover"
                }`}
                key={visibility}
                onClick={() => onChange((current) => ({ ...current, visibility }))}
                role="tab"
                type="button"
              >
                {visibility === "public" ? "公开房间" : "私密房间"}
              </button>
            ))}
          </div>
          <div className="border border-surface-border bg-surface px-3 py-2.5">
            <span className="block text-xs text-foreground-muted">房间类型</span>
            <span className="mt-1 block text-sm font-medium text-foreground">
              {roomType === "request"
                ? "点歌房"
                : roomType === "radio"
                  ? "自由电台"
                  : "多人互动房"}
            </span>
            <span className="mt-1 block text-xs text-foreground-muted">创建后不可更改。</span>
          </div>
          <label className="flex flex-col gap-2 text-sm text-foreground">
            房间名称
            <input
              className="rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-foreground caret-accent outline-none placeholder:text-foreground-muted focus:border-accent focus:ring-1 focus:ring-accent"
              maxLength={120}
              onChange={(event) =>
                onChange((current) => ({ ...current, name: event.target.value }))
              }
              required
              value={form.name}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm text-foreground">
            房间简介 <span className="text-xs text-foreground-muted">可选</span>
            <textarea
              className="min-h-20 resize-y rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-foreground caret-accent outline-none placeholder:text-foreground-muted focus:border-accent focus:ring-1 focus:ring-accent"
              maxLength={500}
              onChange={(event) =>
                onChange((current) => ({ ...current, description: event.target.value }))
              }
              rows={3}
              value={form.description ?? ""}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm text-foreground">
            房间密码 <span className="text-xs text-foreground-muted">留空表示移除密码，至少 4 位</span>
            <input
              className="rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-foreground caret-accent outline-none placeholder:text-foreground-muted focus:border-accent focus:ring-1 focus:ring-accent"
              maxLength={128}
              minLength={4}
              onChange={(event) =>
                onChange((current) => ({ ...current, password: event.target.value }))
              }
              placeholder="留空表示无需密码"
              type="password"
              value={form.password ?? ""}
            />
          </label>
          {roomType === "interactive" ? (
            <div className="flex flex-col gap-2">
              <div>
                <span className="block text-sm text-foreground">新成员默认权限</span>
                <span className="mt-1 block text-xs text-foreground-muted">
                  只影响之后首次进入房间的成员，已有成员权限不会改变。
                </span>
              </div>
              <MemberPermissionControls
                onChange={(permission, checked) =>
                  onChange((current) => ({
                    ...current,
                    newMemberPermissions: {
                      ...getNewMemberPermissions(current),
                      [permission]: checked
                    }
                  }))
                }
                permissions={getNewMemberPermissions({
                  newMemberPermissions: form.newMemberPermissions
                })}
                disabled={pending}
              />
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-3 pt-2">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              取消
            </Button>
            <Button
              disabled={
                pending ||
                !form.name.trim() ||
                (!!form.password?.trim() && form.password.trim().length < 4)
              }
              type="submit"
            >
              {pending ? "保存中..." : "保存修改"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
