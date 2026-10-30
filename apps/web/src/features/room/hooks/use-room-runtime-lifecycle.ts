"use client";

import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type { AuthSession, IceConfigResponse, RoomSnapshot } from "@soqaro/shared";
import type { Route } from "next";
import { toUserFacingError } from "@/lib/domain/soqaro-ui";
import { soqaroApi } from "@/lib/network/soqaro-api";
import type { PeerDiagnosticRecorder } from "@/features/p2p/use-peer-diagnostics";
import type { RoomSnapshotResyncReason } from "@/features/room/room-snapshot-resync";
import type { RoomStateEvent } from "@/features/room/room-state-reducer";
import { testTurnConnectivity } from "@/features/p2p";
import { roomAudioOutput } from "@/features/playback/room-audio-output";

type RoomRouter = {
  push: (href: Route) => void;
  replace: (href: Route) => void;
};

export function shouldRedirectRoomRouteToAuth(input: {
  workspaceOnly: boolean;
  initialRoomId: string | null;
  hydrated: boolean;
  hasActiveSession: boolean;
  hasStoredSession: boolean;
  isNavigatingRoomExit: boolean;
  suppressRoomRecovery: boolean;
}) {
  return (
    input.workspaceOnly &&
    Boolean(input.initialRoomId) &&
    input.hydrated &&
    !input.hasActiveSession &&
    !input.hasStoredSession &&
    !input.isNavigatingRoomExit &&
    !input.suppressRoomRecovery
  );
}

export function shouldSuppressRoomRecoveryAfterFailure(input: {
  cancelled: boolean;
}) {
  return !input.cancelled;
}

export function resetInitialRoomRecoveryAttemptOnCancellation(input: {
  completed: boolean;
  recoveryKey: string;
  initialRecoveryAttemptRef: MutableRefObject<string | null> | { current: string | null };
}) {
  if (!input.completed && input.initialRecoveryAttemptRef.current === input.recoveryKey) {
    input.initialRecoveryAttemptRef.current = null;
  }
}

export function useRoomRuntimeLifecycle(input: {
  workspaceOnly: boolean;
  initialRoomId: string | null;
  hydrated: boolean;
  authEntryHref: string;
  router: RoomRouter;
  lastRoomStorageKey: string;
  peerStorageKey: string;
  activeSession: AuthSession | null;
  hasStoredSession: boolean;
  roomSnapshot: RoomSnapshot | null;
  currentRoomRef: MutableRefObject<RoomSnapshot | null>;
  activeRouteRoomIdRef: MutableRefObject<string | null>;
  resubscribeRoomRef: MutableRefObject<(() => void) | null>;
  initialRecoveryAttemptRef: MutableRefObject<string | null>;
  previousInitialRoomIdRef: MutableRefObject<string | null>;
  resetPlayerSurfaceRef: MutableRefObject<() => void>;
  requestRoomSnapshotResync: (
    reason: RoomSnapshotResyncReason,
    roomId?: string | null
  ) => Promise<void>;
  emitPresence: () => void;
  peerId: string;
  setPeerId: Dispatch<SetStateAction<string>>;
  suppressRoomRecovery: boolean;
  setSuppressRoomRecovery: Dispatch<SetStateAction<boolean>>;
  setIsRecoveringRoom: Dispatch<SetStateAction<boolean>>;
  isNavigatingRoomExit: boolean;
  setIsNavigatingRoomExit: Dispatch<SetStateAction<boolean>>;
  setIceConfig: Dispatch<SetStateAction<IceConfigResponse | null>>;
  setIceConfigResolved: Dispatch<SetStateAction<boolean>>;
  setIsPageVisible: Dispatch<SetStateAction<boolean>>;
  setSchedulerMode: Dispatch<SetStateAction<"normal" | "conservative" | "idle">>;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  deleteRoomTrackArtifacts: (trackIds: string[], roomId?: string, deleteRoomSnapshot?: boolean) => Promise<void> | void;
  recordPeerDiagnostic: PeerDiagnosticRecorder;
  refreshSession: () => Promise<unknown>;
  refreshAvailableRooms: () => Promise<void>;
  refreshPlaylists: () => Promise<void>;
  setStatusMessage: (value: string) => void;
}) {
  const {
    activeRouteRoomIdRef,
    activeSession,
    authEntryHref,
    currentRoomRef,
    dispatchRoomStateEvent,
    deleteRoomTrackArtifacts,
    emitPresence,
    hasStoredSession,
    hydrated,
    initialRecoveryAttemptRef,
    initialRoomId,
    isNavigatingRoomExit,
    lastRoomStorageKey,
    peerId,
    peerStorageKey,
    previousInitialRoomIdRef,
    recordPeerDiagnostic,
    resubscribeRoomRef,
    refreshAvailableRooms,
    refreshPlaylists,
    refreshSession,
    requestRoomSnapshotResync,
    resetPlayerSurfaceRef,
    roomSnapshot,
    router,
    setIceConfig,
    setIceConfigResolved,
    setIsNavigatingRoomExit,
    setIsPageVisible,
    setIsRecoveringRoom,
    setPeerId,
    setSchedulerMode,
    setStatusMessage,
    setSuppressRoomRecovery,
    suppressRoomRecovery,
    workspaceOnly
  } = input;
  const lastPageResumeRecoveryAtRef = useRef(0);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    void refreshSession();
  }, [activeSession, refreshSession]);

  useEffect(() => {
    if (
      !shouldRedirectRoomRouteToAuth({
        workspaceOnly,
        initialRoomId,
        hydrated,
        hasActiveSession: Boolean(activeSession),
        hasStoredSession,
        isNavigatingRoomExit,
        suppressRoomRecovery
      })
    ) {
      return;
    }

    router.replace(authEntryHref as Route);
  }, [
    workspaceOnly,
    initialRoomId,
    hydrated,
    activeSession,
    hasStoredSession,
    isNavigatingRoomExit,
    suppressRoomRecovery,
    router,
    authEntryHref
  ]);

  useEffect(() => {
    let storedPeerId: string | null = null;
    try {
      storedPeerId = window.sessionStorage.getItem(peerStorageKey);
    } catch {
      // Ignore storage errors in restricted WebView or private browsing
    }
    if (storedPeerId) {
      setPeerId(storedPeerId);
      return;
    }

    const randomPart = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextPeerId = `peer_${randomPart}`;
    try {
      window.sessionStorage.setItem(peerStorageKey, nextPeerId);
    } catch {
      // Ignore storage errors
    }
    setPeerId(nextPeerId);
  }, [peerStorageKey, setPeerId]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    void refreshAvailableRooms();
    void refreshPlaylists();
  }, [activeSession, refreshAvailableRooms, refreshPlaylists]);

  useEffect(() => {
    const recoverRealtimeSession = () => {
      // visibilitychange, pageshow, focus and online can fire together when
      // a suspended tab is resumed. Coalesce them so one resume produces one
      // subscribe/resync round-trip instead of repeatedly replacing its own
      // realtime lease.
      const now = Date.now();
      if (now - lastPageResumeRecoveryAtRef.current < 1_500) {
        return;
      }
      lastPageResumeRecoveryAtRef.current = now;
      // Background tabs can outlive the server's realtime lease while the
      // browser keeps Socket.IO in a connected-looking state. Re-subscribe
      // before refreshing presence so the lease and peer topology are rebuilt.
      void roomAudioOutput.resumeSharedAudioContext();
      resubscribeRoomRef.current?.();
      emitPresence();
      void requestRoomSnapshotResync(
        "visibility-visible",
        currentRoomRef.current?.room.id ?? null
      );
    };

    const handlePageVisible = () => {
      if (document.hidden) {
        setIsPageVisible(false);
        return;
      }

      setIsPageVisible(true);
      setSchedulerMode((current) => (current === "idle" ? "normal" : current));
      recoverRealtimeSession();
    };

    const handleNetworkOnline = () => {
      // Recover the room socket even while the tab is hidden so a brief network
      // change during background playback does not exceed the server grace window.
      recoverRealtimeSession();
    };

    document.addEventListener("visibilitychange", handlePageVisible);
    window.addEventListener("pageshow", handlePageVisible);
    window.addEventListener("focus", handlePageVisible);
    window.addEventListener("online", handleNetworkOnline);
    return () => {
      document.removeEventListener("visibilitychange", handlePageVisible);
      window.removeEventListener("pageshow", handlePageVisible);
      window.removeEventListener("focus", handlePageVisible);
      window.removeEventListener("online", handleNetworkOnline);
    };
  }, [
    currentRoomRef,
    emitPresence,
    requestRoomSnapshotResync,
    setIsPageVisible,
    setSchedulerMode,
    resubscribeRoomRef
  ]);

  useEffect(() => {
    if (!roomSnapshot?.room.id || !activeSession) {
      setIceConfig(null);
      setIceConfigResolved(false);
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    setIceConfigResolved(false);

    const clearRefreshTimer = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };

    const scheduleIceConfigRefresh = (nextIceConfig: IceConfigResponse) => {
      clearRefreshTimer();
      // Static and stun-only credentials never expire; ephemeral TURN
      // credentials do, and coturn rejects HMAC credentials whose expiry has
      // passed. Renew at 80% of the TTL so any PeerConnection created later
      // (reconnects, newly joined peers) still gathers relay candidates.
      if (nextIceConfig.source !== "ephemeral") {
        return;
      }
      const refreshDelayMs = Math.max(30_000, Math.floor(nextIceConfig.ttlSeconds * 800));
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadIceConfig(true);
      }, refreshDelayMs);
    };

    const loadIceConfig = async (isRefresh: boolean) => {
      try {
        const nextIceConfig = await soqaroApi.getIceConfig();
        if (cancelled) {
          return;
        }

        setIceConfig(nextIceConfig);
        if (!isRefresh) {
          setIceConfigResolved(true);
        }
        scheduleIceConfigRefresh(nextIceConfig);
        recordPeerDiagnostic({
          peerId: "system",
          channelKind: "system",
          direction: "local",
          event: isRefresh ? "ice-config-refreshed" : "ice-config",
          summary: isRefresh
            ? `TURN 凭证已刷新（来源：${nextIceConfig.source}）`
            : `ICE 配置来源：${nextIceConfig.source}`,
          update: (snapshot) => ({
            ...snapshot,
            mediaConnectionState: nextIceConfig.source,
            iceConfigSource: nextIceConfig.source
          })
        });

        // Run TURN connectivity test in background — does not block setup.
        if (nextIceConfig.source !== "stun-only") {
          void testTurnConnectivity(nextIceConfig.iceServers).then((result) => {
            if (cancelled) return;
            const level: "info" | "warning" | "error" = result.reachable ? "info" : "error";
            recordPeerDiagnostic({
              peerId: "system",
              channelKind: "system",
              direction: "local",
              event: "turn-connectivity-test",
              level,
              summary: result.reachable
                ? `TURN 中继可达 (${result.relayCandidates} relay / ${result.totalCandidates} total, ${result.gatherDurationMs}ms)`
                : result.error === "no-turn-servers-configured"
                  ? "未配置 TURN 服务器"
                  : `TURN 中继不可达！${result.error ?? "无法收集 relay 候选"} (${result.gatherDurationMs}ms)，请检查 coturn 是否运行、防火墙端口是否开放`,
              update: (snapshot) => ({
                ...snapshot,
                lastError: result.reachable
                  ? snapshot.lastError
                  : "TURN 中继服务器不可达，跨网络用户将无法同步播放。请检查服务器 TURN 端口是否开放。",
                iceConfigSource: result.reachable ? snapshot.iceConfigSource : "stun-only"
              })
            });
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (!isRefresh) {
          setIceConfig(null);
          setIceConfigResolved(true);
          recordPeerDiagnostic({
            peerId: "system",
            channelKind: "system",
            direction: "local",
            event: "ice-config-fallback",
            level: "warning",
            summary: `ICE 配置获取失败，已回退静态配置：${toUserFacingError(error)}`,
            update: (snapshot) => ({
              ...snapshot,
              lastError: toUserFacingError(error),
              iceConfigSource: "stun-only"
            })
          });
          return;
        }

        // Refreshing means the current credentials are about to expire (or
        // already have). Keep retrying on a short interval until a new config
        // lands instead of letting stale credentials persist for the TTL.
        recordPeerDiagnostic({
          peerId: "system",
          channelKind: "system",
          direction: "local",
          event: "ice-config-refresh-failed",
          level: "warning",
          summary: `TURN 凭证刷新失败，30 秒后重试：${toUserFacingError(error)}`,
          update: (snapshot) => ({ ...snapshot })
        });
        clearRefreshTimer();
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void loadIceConfig(true);
        }, 30_000);
      }
    };

    void loadIceConfig(false);

    return () => {
      cancelled = true;
      clearRefreshTimer();
    };
  }, [
    roomSnapshot?.room.id,
    activeSession,
    setIceConfig,
    setIceConfigResolved,
    recordPeerDiagnostic
  ]);

  useEffect(() => {
    if (
      suppressRoomRecovery ||
      !workspaceOnly ||
      !initialRoomId ||
      !hydrated ||
      !activeSession ||
      isNavigatingRoomExit
    ) {
      return;
    }

    const recoveryKey = `${activeSession.userId}:${initialRoomId}`;
    if (initialRecoveryAttemptRef.current === recoveryKey) {
      return;
    }
    initialRecoveryAttemptRef.current = recoveryKey;

    let cancelled = false;
    let completed = false;
    setIsRecoveringRoom(true);

    void (async () => {
      try {
        let joinError: unknown = null;
        try {
          await soqaroApi.joinRoom(initialRoomId);
        } catch (error) {
          // Existing members and hosts can already access the room even when
          // the room password prevents a redundant join request.
          joinError = error;
        }

        const sync = await soqaroApi.syncRoom(initialRoomId, 0);
        if (sync.roomDeleted) {
          await deleteRoomTrackArtifacts(
            sync.deletedTracks.map((track) => track.trackId),
            initialRoomId,
            true
          );
        }
        const snapshot = sync.roomDeleted ? null : sync.snapshot;
        if (
          joinError &&
          (!snapshot || !snapshot.room.members.some((member) => member.id === activeSession.userId))
        ) {
          throw joinError;
        }
        if (!snapshot || cancelled) {
          if (!cancelled) {
            setSuppressRoomRecovery(true);
            setStatusMessage("未找到可恢复的房间状态，请返回音乐房重新创建或加入房间。");
            setIsRecoveringRoom(false);
          }
          return;
        }

        dispatchRoomStateEvent({
          type: "recover-snapshot",
          snapshot
        });
        setStatusMessage(`已进入房间 ${snapshot.room.joinCode}。`);
        await refreshPlaylists();
      } catch {
        if (shouldSuppressRoomRecoveryAfterFailure({ cancelled })) {
          setSuppressRoomRecovery(true);
          setStatusMessage("未找到可恢复的房间状态，请返回音乐房重新创建或加入房间。");
        }
      } finally {
        completed = true;
        if (!cancelled) {
          setIsRecoveringRoom(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      resetInitialRoomRecoveryAttemptOnCancellation({
        completed,
        recoveryKey,
        initialRecoveryAttemptRef
      });
    };
  }, [
    workspaceOnly,
    initialRoomId,
    hydrated,
    activeSession,
    suppressRoomRecovery,
    isNavigatingRoomExit,
    refreshPlaylists,
    dispatchRoomStateEvent,
    deleteRoomTrackArtifacts,
    setIsRecoveringRoom,
    setSuppressRoomRecovery,
    setStatusMessage,
    initialRecoveryAttemptRef
  ]);

  useEffect(() => {
    activeRouteRoomIdRef.current = initialRoomId;

    if (!workspaceOnly || !initialRoomId) {
      previousInitialRoomIdRef.current = initialRoomId;
      return;
    }

    if (previousInitialRoomIdRef.current === initialRoomId) {
      return;
    }

    previousInitialRoomIdRef.current = initialRoomId;
    initialRecoveryAttemptRef.current = null;
    setSuppressRoomRecovery(false);
    setIsRecoveringRoom(false);
    setIsNavigatingRoomExit(false);
    resetPlayerSurfaceRef.current();
    roomAudioOutput.releaseRoomAudioSession();

    if (roomSnapshot?.room.id && roomSnapshot.room.id !== initialRoomId) {
      dispatchRoomStateEvent({ type: "local-reset" });
    }
  }, [
    dispatchRoomStateEvent,
    workspaceOnly,
    initialRoomId,
    roomSnapshot?.room.id,
    setIsNavigatingRoomExit,
    setIsRecoveringRoom,
    setSuppressRoomRecovery,
    activeRouteRoomIdRef,
    previousInitialRoomIdRef,
    initialRecoveryAttemptRef,
    resetPlayerSurfaceRef
  ]);

  useEffect(() => {
    if (!roomSnapshot?.room.id || !peerId) {
      return;
    }

    window.localStorage.setItem(lastRoomStorageKey, roomSnapshot.room.id);
  }, [roomSnapshot?.room.id, peerId, lastRoomStorageKey]);
}
