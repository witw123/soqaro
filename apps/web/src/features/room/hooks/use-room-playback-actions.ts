"use client";

import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from "react";
import type { QueueItem, RoomSnapshot } from "@soqaro/shared";
import { toUserFacingError } from "@/lib/domain/soqaro-ui";
import { roomAudioOutput } from "@/features/playback/room-audio-output";
import type { PeerDiagnosticRecorder } from "@/features/p2p/use-peer-diagnostics";

type UseRoomPlaybackActionsInput = {
  currentPlaybackPositionRef: MutableRefObject<number>;
  audioRef: RefObject<HTMLAudioElement | null>;
  roomSnapshot: RoomSnapshot | null;
  currentPlaybackTrackId: string | null;
  playbackStatus: RoomSnapshot["room"]["playback"]["status"] | null;
  isCurrentSourceOwner: boolean;
  audioUnlocked: boolean;
  handleTrackFilesSelected: (files: FileList | File[] | null) => Promise<void>;
  addToQueue: (trackId: string) => Promise<QueueItem | null>;
  playTrack: (trackId?: string) => Promise<unknown>;
  playQueueItem: (queueItemId: string, trackId?: string) => Promise<unknown>;
  prevTrack: () => Promise<unknown>;
  nextTrack: () => Promise<unknown>;
  recordPeerDiagnostic: PeerDiagnosticRecorder;
  setAudioBlockedOverlay: Dispatch<SetStateAction<boolean>>;
  setAudioUnlocked: Dispatch<SetStateAction<boolean>>;
  setStatusMessage: (value: string) => void;
};

export function startBestEffortPlaybackAudioUnlock(input: {
  unlockAudio: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  void input.unlockAudio().catch((error) => {
    input.onError?.(error);
  });
}

export function isSegmentedAudioOutputReady() {
  return roomAudioOutput.isActivated() && roomAudioOutput.isAudioContextReady();
}

export function useRoomPlaybackActions({
  currentPlaybackPositionRef,
  audioRef,
  roomSnapshot,
  currentPlaybackTrackId,
  playbackStatus,
  isCurrentSourceOwner,
  audioUnlocked,
  handleTrackFilesSelected,
  addToQueue,
  playTrack,
  playQueueItem,
  prevTrack,
  nextTrack,
  recordPeerDiagnostic,
  setAudioBlockedOverlay,
  setAudioUnlocked,
  setStatusMessage
}: UseRoomPlaybackActionsInput) {
  const ensureRoomAudioUnlocked = useCallback(
    async (reason: string) => {
      if (isSegmentedAudioOutputReady()) {
        setAudioUnlocked(true);
        return true;
      }

      try {
        if (isCurrentSourceOwner) {
          // The source path is driven by Web Audio. After a long pause the
          // concrete media element used for priming may be stale or blocked,
          // while the shared context can still be resumed immediately.
          // Do not make room playback wait for that unrelated element promise.
          const contextReady = await roomAudioOutput.resumeSharedAudioContext();
          if (contextReady) {
            setAudioUnlocked(true);
            void roomAudioOutput.primeOutputs({ localAudio: audioRef.current });
            return true;
          }
        }
        await roomAudioOutput.primeOutputs({ localAudio: audioRef.current });
        const audioReady = isSegmentedAudioOutputReady();
        setAudioUnlocked(audioReady);
        if (!audioReady) {
          const message = "浏览器仍未允许房间音频输出";
          setStatusMessage(message);
          recordPeerDiagnostic({
            peerId: "system",
            channelKind: "system",
            direction: "local",
            event: "audio-unlock-failed",
            level: "warning",
            summary: message,
            update: (snapshot) => ({
              ...snapshot,
              lastError: message
            })
          });
          return false;
        }
        recordPeerDiagnostic({
          peerId: "system",
          channelKind: "system",
          direction: "local",
          event: "audio-unlocked",
          summary: `房间音频已解锁：${reason}`,
          recordEvent: false,
          update: (snapshot) => ({
            ...snapshot,
            lastError: null
          })
        });
        return true;
      } catch (error) {
        const message = toUserFacingError(error);
        setAudioUnlocked(isSegmentedAudioOutputReady());
        recordPeerDiagnostic({
          peerId: "system",
          channelKind: "system",
          direction: "local",
          event: "audio-unlock-failed",
          level: "error",
          summary: `房间音频解锁失败：${message}`,
          update: (snapshot) => ({
            ...snapshot,
            lastError: `房间音频解锁失败：${message}`
          })
        });
        return false;
      }
    },
    [
      recordPeerDiagnostic,
      audioRef,
      isCurrentSourceOwner,
      setAudioUnlocked,
      setStatusMessage
    ]
  );

  const tryUnlockRemoteAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (isCurrentSourceOwner || !audio?.srcObject) {
      return null;
    }

    // Most listeners use native MediaStream output. If this same element was
    // previously connected as a source, its output cannot return to native
    // routing, so reconnect it and resume the graph within this user gesture.
    const remoteUsesWebAudioGraph = roomAudioOutput.hasLocalAudioElementSource(audio);
    if (remoteUsesWebAudioGraph) {
      roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false });
    }
    const result = await roomAudioOutput.playElement(audio, {
      force: true,
      resumeAudioContext: remoteUsesWebAudioGraph,
      requireRunningAudioContext: remoteUsesWebAudioGraph,
      allowMutedFallback: false
    });
    return result.ok;
  }, [audioRef, isCurrentSourceOwner]);

  const handlePlaybackPositionChange = useCallback((positionMs: number) => {
    currentPlaybackPositionRef.current = positionMs;
  }, [currentPlaybackPositionRef]);

  const handleFilesSelected = useCallback(
    async (files: FileList | File[] | null) => {
      try {
        if (files && Array.from(files).length > 0) {
          await ensureRoomAudioUnlocked("track-upload");
        }
        await handleTrackFilesSelected(files);
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [ensureRoomAudioUnlocked, handleTrackFilesSelected, setStatusMessage]
  );

  const armPlaybackStart = useCallback(
    async (reason: "track-change" | "user-play" | "queue-advance") => {
      setStatusMessage("正在准备音源...");
      startBestEffortPlaybackAudioUnlock({
        unlockAudio: () => ensureRoomAudioUnlocked(`playback-intent:${reason}`),
        onError: (error) => {
          const message = toUserFacingError(error);
          recordPeerDiagnostic({
            peerId: "system",
            channelKind: "system",
            direction: "local",
            event: "audio-prime-failed",
            level: "error",
            summary: `音频输出预激活失败：${message}`,
            update: (snapshot) => ({
              ...snapshot,
              lastError: `音频输出预激活失败：${message}`
            })
          });
          setStatusMessage("音频输出初始化失败，已跳过预激活并继续尝试播放。");
        }
      });
    },
    [
      ensureRoomAudioUnlocked,
      recordPeerDiagnostic,
      setStatusMessage
    ]
  );

  useEffect(() => {
    if (!roomSnapshot?.room.id || audioUnlocked) {
      return;
    }

    const handleFirstInteraction = () => {
      void ensureRoomAudioUnlocked("natural-room-interaction");
    };

    window.addEventListener("pointerdown", handleFirstInteraction, {
      capture: true,
      passive: true
    });
    window.addEventListener("touchstart", handleFirstInteraction, {
      capture: true,
      passive: true
    });
    window.addEventListener("keydown", handleFirstInteraction, true);

    return () => {
      window.removeEventListener("pointerdown", handleFirstInteraction, true);
      window.removeEventListener("touchstart", handleFirstInteraction, true);
      window.removeEventListener("keydown", handleFirstInteraction, true);
    };
  }, [audioUnlocked, ensureRoomAudioUnlocked, roomSnapshot?.room.id]);

  const handlePlayTrack = useCallback(
    async (trackId?: string) => {
      const existingQueueItem = trackId
        ? roomSnapshot?.queue.find((item) => item.trackId === trackId) ?? null
        : null;
      const queueItem = trackId && !existingQueueItem
        ? await addToQueue(trackId)
        : existingQueueItem;
      if (trackId && !queueItem) return;

      await armPlaybackStart(trackId ? "track-change" : "user-play");
      if (queueItem) {
        // The queue mutation updates the reducer asynchronously. Pass the
        // resolved track id so playback can include its asset even while the
        // callback still holds the previous room snapshot.
        await playQueueItem(queueItem.id, queueItem.trackId);
        return;
      }
      await playTrack(trackId);
    },
    [
      addToQueue,
      armPlaybackStart,
      playQueueItem,
      playTrack,
      roomSnapshot?.queue
    ]
  );

  const handlePlayQueueItem = useCallback(
    async (queueItemId: string) => {
      await armPlaybackStart("queue-advance");
      await playQueueItem(queueItemId);
    },
    [
      armPlaybackStart,
      playQueueItem
    ]
  );

  const handlePrevTrack = useCallback(async () => {
    await armPlaybackStart("queue-advance");
    await prevTrack();
  }, [armPlaybackStart, prevTrack]);

  const handleNextTrack = useCallback(async () => {
    await armPlaybackStart("queue-advance");
    await nextTrack();
  }, [armPlaybackStart, nextTrack]);

  useEffect(() => {
    if (
      !audioUnlocked &&
      !isCurrentSourceOwner &&
      playbackStatus === "playing" &&
      currentPlaybackTrackId
    ) {
      const timer = window.setTimeout(() => {
        // A listener may use native MediaStream output without a running
        // AudioContext. The runtime only marks this unlocked after the
        // concrete element's audible play() succeeds, so do not gate the
        // overlay on the source-only Web Audio readiness check here.
        setAudioBlockedOverlay(true);
      }, 1500);
      return () => window.clearTimeout(timer);
    }

    setAudioBlockedOverlay(false);
  }, [
    audioUnlocked,
    currentPlaybackTrackId,
    isCurrentSourceOwner,
    playbackStatus,
    setAudioBlockedOverlay
  ]);

  const handleAudioUnlock = useCallback(async () => {
    setAudioBlockedOverlay(false);
    const remoteUnlocked = await tryUnlockRemoteAudio();
    if (remoteUnlocked === true) {
      setAudioUnlocked(true);
      setStatusMessage("");
      return;
    }
    if (remoteUnlocked === false) {
      setAudioUnlocked(false);
      setStatusMessage("浏览器仍未允许远端音频输出，请再次点击播放或检查系统媒体权限。");
      setAudioBlockedOverlay(true);
      return;
    }
    await roomAudioOutput.primeOutputs({ localAudio: audioRef.current });
    const audioReady = isSegmentedAudioOutputReady();
    setAudioUnlocked(audioReady);
    if (audioReady) {
      setStatusMessage("");
      return;
    }
    setStatusMessage("浏览器仍未允许音频输出，请再次点击播放或检查系统媒体权限。");
    setAudioBlockedOverlay(true);
  }, [
    audioRef,
    setAudioBlockedOverlay,
    setAudioUnlocked,
    setStatusMessage,
    tryUnlockRemoteAudio
  ]);

  return {
    handleAudioUnlock,
    handleFilesSelected,
    handleNextTrack,
    handlePlayQueueItem,
    handlePlaybackPositionChange,
    handlePlayTrack,
    handlePrevTrack
  };
}
