"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { PeerDiagnosticsSnapshot, PeerSignalMessage, RoomSnapshot } from "@soqaro/shared";
import {
  P2PMesh,
  createPeerConnectionSupervisorState,
  markMediaRecoveryAttempt,
  resolvePreferredIceTransportPolicy
} from "@/features/p2p";
import type { RemoteAudioTrackListener } from "@/features/p2p";
import { createPeerTelemetryReport, sumFiniteRates } from "@/features/p2p/peer-telemetry";
import type {
  PlaybackRecoveryRecommendation,
  RoomDataMeshDiagnosticsRefs
} from "./room-runtime-types";

const telemetryPublishIntervalMs = 1_000;

export function updatePeerMembership(
  setPeers: Dispatch<SetStateAction<string[]>>,
  peerId: string,
  shouldBePresent: boolean
) {
  setPeers((current) => {
    const index = current.indexOf(peerId);
    if (shouldBePresent) {
      return index >= 0 ? current : [...current, peerId];
    }
    return index < 0
      ? current
      : current.filter((currentPeerId) => currentPeerId !== peerId);
  });
}

export function resolveDataPeerRecoveryRecommendation(input: {
  peerId: string;
  dataChannelState?: string | null;
  dataConnectionState?: string | null;
  reason: string;
}): PlaybackRecoveryRecommendation | null {
  const failedDataChannel = input.dataChannelState === "closed";
  const failedDataConnection =
    input.dataConnectionState === "closed" ||
    input.dataConnectionState === "failed";
  const stalledReason =
    input.reason === "watchdog-timeout" ||
    input.reason === "connection-failed" ||
    input.reason === "data-channel-closed";

  if (!failedDataChannel && !failedDataConnection && !stalledReason) {
    return null;
  }

  return {
    playbackConnectionKey: null,
    peerId: input.peerId,
    scope: "data",
    level: "hard-recreate",
    reason: input.reason,
    observedNoProgressMs: null
  };
}

export function createRoomDataMeshRuntime(input: {
  roomId: string;
  peerId: string;
  emitPeerSignal: (payload: PeerSignalMessage) => void;
  iceServersRef: MutableRefObject<RTCIceServer[]>;
  meshRef: MutableRefObject<P2PMesh | null>;
  localAudibleRef: MutableRefObject<boolean | null>;
  currentRoomRef: MutableRefObject<RoomSnapshot | null>;
  setConnectedPeers: Dispatch<SetStateAction<string[]>>;
  setMediaConnectedPeers: Dispatch<SetStateAction<string[]>>;
  isPageVisible: boolean;
  playbackStatus: RoomSnapshot["room"]["playback"]["status"] | null | undefined;
  currentTrackId: string | null | undefined;
  queuePlaybackRecoveryRecommendation?: (recommendation: PlaybackRecoveryRecommendation) => void;
  reportMeshResyncFailure: (error: unknown) => void;
  onRemoteAudioTrack?: RemoteAudioTrackListener;
} & RoomDataMeshDiagnosticsRefs) {
  const peerBufferedAmountBytes = new Map<string, number>();
  const latestMediaSamples = new Map<string, {
    sendRateKbps: number | null;
    receiveRateKbps: number | null;
    rttMs: number | null;
    updatedAtMs: number;
  }>();
  let lastTelemetryBroadcastAtMs = 0;
  let lastPublishedHadTraffic = false;
  let lastPublishedAudible: boolean | null = null;

  const publishLocalTelemetry = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTelemetryBroadcastAtMs < telemetryPublishIntervalMs) {
      return;
    }

    // Drop stale peer samples so totals stay accurate after peer leave.
    for (const [peerId, sample] of [...latestMediaSamples.entries()]) {
      if (now - sample.updatedAtMs > 4_000) {
        latestMediaSamples.delete(peerId);
      }
    }

    const samples = [...latestMediaSamples.values()];
    const sendRateKbps = sumFiniteRates(samples.map((sample) => sample.sendRateKbps));
    const receiveRateKbps = sumFiniteRates(samples.map((sample) => sample.receiveRateKbps));
    const hasAnySample = samples.length > 0;
    const nextSend = sendRateKbps ?? 0;
    const nextReceive = receiveRateKbps ?? 0;
    const hasTraffic = nextSend > 0 || nextReceive > 0;
    const audible = input.localAudibleRef.current;
    // Publish zeros once traffic ends so remotes do not freeze the last non-zero rates.
    if (
      !force &&
      !hasAnySample &&
      !hasTraffic &&
      !lastPublishedHadTraffic &&
      audible === lastPublishedAudible
    ) {
      return;
    }

    lastTelemetryBroadcastAtMs = now;
    lastPublishedHadTraffic = hasTraffic;
    lastPublishedAudible = audible;
    const report = createPeerTelemetryReport({
      fromPeerId: input.peerId,
      sendRateKbps: nextSend,
      receiveRateKbps: nextReceive,
      audible,
      reportedAt: new Date(now).toISOString()
    });
    // Keep local member diagnostics current even before remote peers are connected.
    input.recordPeerDiagnosticRef.current({
      peerId: "system",
      channelKind: "system",
      direction: "local",
      event: "local-media-telemetry",
      summary: "Local aggregate media telemetry updated",
      recordEvent: false,
      update: (snapshot) => ({
        ...snapshot,
        reportedSendRateKbps: report.sendRateKbps,
        reportedReceiveRateKbps: report.receiveRateKbps,
        reportedTelemetryAt: report.reportedAt,
        reportedAudible: report.audible,
        reportedAudibleAt: report.reportedAt,
        // Do not overwrite path-level mediaSend/Receive with aggregate totals.
        lastMediaStatsProgressAt:
          (report.sendRateKbps ?? 0) > 0 || (report.receiveRateKbps ?? 0) > 0
            ? report.reportedAt
            : snapshot.lastMediaStatsProgressAt
      })
    });
    input.meshRef.current?.sendPeerTelemetry(report);
  };

  const queueDataPeerRecovery = (peerId: string, reason: string, dataChannelState?: string) => {
    const recommendation = resolveDataPeerRecoveryRecommendation({
      peerId,
      reason,
      dataChannelState
    });
    if (recommendation) {
      input.queuePlaybackRecoveryRecommendation?.(recommendation);
    }
  };

  const mesh = new P2PMesh(
    input.roomId,
    input.peerId,
    input.emitPeerSignal,
    {
      onPeerConnectionChange: ({ peerId, state, linkKind = "data" }) => {
        const supervisorState = input.updateConnectionSupervisorSignalState({
          peerId,
          channelKind: linkKind,
          ...(linkKind === "media"
            ? { mediaConnectionState: state }
            : { dataConnectionState: state })
        });
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: linkKind,
          direction: "local",
          event: linkKind === "media" ? "media-connection-state" : "connection-state",
          summary: `${linkKind === "media" ? "Media" : "Data"} 连接状态：${state}`,
          update: (snapshot: PeerDiagnosticsSnapshot) =>
            input.withResolvedTransportHealth({
              ...input.withSupervisorDiagnosticPatch(snapshot, supervisorState),
              ...(linkKind === "media"
                ? {
                    mediaConnectionState: state,
                    ...(state === "new" || state === "connecting"
                      ? { mediaTrackState: "none" as const }
                      : state === "failed" || state === "closed"
                        ? { mediaTrackState: "failed" as const }
                        : {})
                  }
                : { dataConnectionState: state })
            })
        });
        if (linkKind === "media") {
          const latestSample = latestMediaSamples.get(peerId);
          const sampleIsFresh = latestSample !== undefined &&
            Date.now() - latestSample.updatedAtMs <= 4_000;
          const operational = state === "connected" &&
            sampleIsFresh && (
              (latestSample?.receiveRateKbps ?? 0) > 0 ||
              (latestSample?.sendRateKbps ?? 0) > 0
            );
          updatePeerMembership(input.setMediaConnectedPeers, peerId, operational);
          if (state === "failed" || state === "closed") {
            latestMediaSamples.delete(peerId);
            publishLocalTelemetry(true);
          }
          return;
        }
        // A connected RTCPeerConnection can still have a connecting or
        // closed control channel. DataChannel open is the authoritative
        // readiness signal for room presence/recovery traffic.
        // ICE can recover in place while the DataChannel stays open, so
        // re-read the channel state on the connection transition.
        updatePeerMembership(
          input.setConnectedPeers,
          peerId,
          state === "connected" && input.meshRef.current?.getConnectedPeerIds().includes(peerId) === true
        );
        if (state === "closed" || state === "failed") {
          peerBufferedAmountBytes.delete(peerId);
          queueDataPeerRecovery(peerId, "data-failed", state);
        }
      },
      onIceConnectionStateChange: ({ peerId, state, linkKind = "data" }) => {
        const supervisorState = input.updateConnectionSupervisorSignalState({
          peerId,
          channelKind: linkKind,
          ...(linkKind === "media" ? { mediaIceState: state } : { dataIceState: state })
        });
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: linkKind,
          direction: "local",
          event: linkKind === "media" ? "media-ice-state" : "ice-state",
          summary: `${linkKind === "media" ? "Media" : "Data"} ICE 状态：${state}`,
          update: (snapshot: PeerDiagnosticsSnapshot) =>
            input.withResolvedTransportHealth(
              input.withSupervisorDiagnosticPatch(snapshot, supervisorState)
            )
        });
      },
      onDataChannelStateChange: ({ peerId, state }) => {
        const supervisorState = input.updateConnectionSupervisorSignalState({
          peerId,
          channelKind: "data",
          dataChannelState: state
        });
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: "data",
          direction: "local",
          event: "data-channel-state",
          summary: `Data channel 状态：${state}`,
          recordEvent: false,
          update: (snapshot: PeerDiagnosticsSnapshot) =>
            input.withResolvedTransportHealth({
              ...input.withSupervisorDiagnosticPatch(snapshot, supervisorState),
              dataChannelState: state,
              lastDataActivityAt:
                state === "open" ? new Date().toISOString() : snapshot.lastDataActivityAt
            })
        });
        updatePeerMembership(input.setConnectedPeers, peerId, state === "open");
        if (state === "open") {
          // Push current aggregate immediately so the new peer does not wait a full sample cycle.
          publishLocalTelemetry(true);
        }
        if (state === "closed") {
          latestMediaSamples.delete(peerId);
          // Remote self-report becomes unavailable once the control channel drops.
          input.recordPeerDiagnosticRef.current({
            peerId,
            channelKind: "data",
            direction: "local",
            event: "peer-media-telemetry-cleared",
            summary: "Cleared remote media telemetry after data channel closed",
            recordEvent: false,
            update: (snapshot) => ({
              ...snapshot,
              reportedSendRateKbps: null,
              reportedReceiveRateKbps: null,
              reportedTelemetryAt: null,
              reportedAudible: null,
              reportedAudibleAt: null
            })
          });
          queueDataPeerRecovery(peerId, "data-channel-closed", state);
          publishLocalTelemetry(true);
        }
      },
      onDataBufferedAmountChange: ({ peerId, bufferedAmountBytes }) => {
        peerBufferedAmountBytes.set(peerId, bufferedAmountBytes);
        input.updatePeerBufferedAmountRef.current(peerId, bufferedAmountBytes);
      },
      onPeerReleased: (peerId) => {
        // The manager only reports peers that left the admitted topology.
        // Without this the per-peer supervisor state (with its sample history)
        // would accumulate for every peer ever seen in the room.
        input.connectionSupervisorStatesRef.current.delete(peerId);
      },
      onStatsSample: ({ peerId, linkKind = "data", sample }) => {
        input.updateConnectionSupervisorTransportStats({
          peerId,
          sample,
          channelKind: linkKind
        });
        const isMediaSample = linkKind === "media";
        if (isMediaSample) {
          // RTP activity can become usable after the peer connection reaches
          // `connected`. Re-evaluate the transport on every media sample so
          // the member count follows the actual receiver/sender state rather
          // than the earlier ICE transition alone.
          latestMediaSamples.set(peerId, {
            sendRateKbps: sample.mediaSendBitrateKbps,
            receiveRateKbps: sample.mediaReceiveBitrateKbps,
            rttMs: sample.currentRoundTripTimeMs,
            updatedAtMs: Date.now()
          });
          const transportReady =
            (sample.connectionState === null || sample.connectionState === undefined ||
              sample.connectionState === "connected") &&
            (sample.iceConnectionState === null || sample.iceConnectionState === undefined ||
              sample.iceConnectionState === "connected" ||
              sample.iceConnectionState === "completed");
          updatePeerMembership(
            input.setMediaConnectedPeers,
            peerId,
            transportReady && (
              (sample.mediaReceiveBitrateKbps ?? 0) > 0 ||
              (sample.mediaSendBitrateKbps ?? 0) > 0
            )
          );
          publishLocalTelemetry();
        } else if (latestMediaSamples.has(peerId)) {
          // Keep publishing after media samples pause so zeros/stale totals clear promptly.
          publishLocalTelemetry();
        }
        (isMediaSample
          ? input.updateMediaTransportStatsRef ?? input.updateDataTransportStatsRef
          : input.updateDataTransportStatsRef).current({ peerId, sample });
      },
      onPeerTelemetry: ({ peerId, report }) => {
        const reporterPeerId = report.fromPeerId || peerId;
        if (reporterPeerId === input.peerId) {
          return;
        }
        input.recordPeerDiagnosticRef.current({
          peerId: reporterPeerId,
          channelKind: "data",
          direction: "received",
          event: "peer-media-telemetry",
          summary: "Remote peer media telemetry updated",
          recordEvent: false,
          update: (snapshot) => ({
            ...snapshot,
            dataChannelState: "open",
            lastDataActivityAt: report.reportedAt,
            // Keep mediaSend/Receive as this browser's path samples for mesh diagnostics.
            // Store self-reported aggregates separately for the members panel.
            reportedSendRateKbps: report.sendRateKbps,
            reportedReceiveRateKbps: report.receiveRateKbps,
            reportedTelemetryAt: report.reportedAt,
            reportedAudible: report.audible,
            reportedAudibleAt: report.reportedAt,
            lastMediaStatsProgressAt:
              (report.sendRateKbps ?? 0) > 0 || (report.receiveRateKbps ?? 0) > 0
                ? report.reportedAt
                : snapshot.lastMediaStatsProgressAt,
            currentRoundTripTimeMs: report.rttMs ?? snapshot.currentRoundTripTimeMs
          })
        });
      },
      onRemoteAudioTrack: ({ peerId, stream, track }) => {
        input.onRemoteAudioTrack?.({ peerId, stream, track });
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: "media",
          direction: "received",
          event: "media-track-received",
          summary: `收到媒体音频轨道 ${track.id}`,
          update: (snapshot: PeerDiagnosticsSnapshot) => snapshot
        });
      },
      onMediaTrackMuted: ({ peerId, trackId }) => {
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: "media",
          direction: "received",
          event: "media-track-muted",
          summary: `媒体轨道短暂静音：${trackId}`,
          level: "warning"
        });
      },
      onMediaStateChange: ({ peerId, direction, state }) => {
        if (state === "none" || state === "ended" || state === "failed") {
          latestMediaSamples.delete(peerId);
          updatePeerMembership(input.setMediaConnectedPeers, peerId, false);
          publishLocalTelemetry(true);
        }
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: "media",
          direction: "local",
          event: `media-track-${state}`,
          summary: `${direction === "sender" ? "发送" : "接收"}媒体轨道：${state}`,
          recordEvent: false,
          update: (snapshot: PeerDiagnosticsSnapshot) => ({
            ...snapshot,
            mediaConnectionState:
              state === "live"
                ? "connected"
                : state === "none"
                  ? "closed"
                : state === "failed"
                  ? "failed"
                  : snapshot.mediaConnectionState,
            mediaTrackState: state,
          })
        });
        if (direction === "receiver" && state === "live") {
          const latestSample = latestMediaSamples.get(peerId);
          const sampleIsFresh = latestSample !== undefined &&
            Date.now() - latestSample.updatedAtMs <= 4_000;
          const operational = state === "live" &&
            sampleIsFresh && (
              (latestSample?.receiveRateKbps ?? 0) > 0 ||
              (latestSample?.sendRateKbps ?? 0) > 0
            );
          updatePeerMembership(input.setMediaConnectedPeers, peerId, operational);
        }
      },
      onMediaRecovery: ({ peerId, reason, restartCount }) => {
        const currentSupervisorState =
          input.connectionSupervisorStatesRef.current.get(peerId) ??
          createPeerConnectionSupervisorState({
            peerId,
            roomId: input.roomId
          });
        const nextSupervisorState = markMediaRecoveryAttempt({
          state: currentSupervisorState,
          restartCount,
          reason
        });
        input.connectionSupervisorStatesRef.current.set(peerId, nextSupervisorState);
        const nextIcePolicy = resolvePreferredIceTransportPolicy(
          nextSupervisorState,
          input.iceServersRef.current
        );
        input.recordPeerDiagnosticRef.current({
          peerId,
          channelKind: "media",
          direction: "local",
          event: reason === "connection-failed" ? "media-recovery-failed" : "media-ice-restart",
          summary: restartCount >= 3
            ? nextIcePolicy === "relay"
              ? "媒体直连连续恢复失败，重建媒体连接并切换 TURN 中继"
              : "TURN 中继恢复失败，重建媒体连接并回退自动选路"
            : `媒体链路已执行 ICE restart（${reason}，第 ${restartCount} 次）`,
          level: reason === "connection-failed" ? "error" : "warning"
        });
      },
      onPeerStalled: ({ peerId, reason }) => {
        input.updateConnectionSupervisorSignalState({
          peerId,
          channelKind: "data",
          lastFailureReason: reason
        });
        queueDataPeerRecovery(peerId, reason);
      }
    },
    input.iceServersRef.current,
    {
      autoReconnect: true,
      resolveConnectionConfig: (peerId) => ({
        iceTransportPolicy: resolvePreferredIceTransportPolicy(
          input.connectionSupervisorStatesRef.current.get(peerId),
          input.iceServersRef.current
        )
      })
    }
  );

  input.meshRef.current = mesh;
  mesh.setStatsSamplingMode(
    !input.currentTrackId || (!input.isPageVisible && input.playbackStatus !== "playing")
      ? "off"
      : "steady"
  );

  const resyncRealtimePeers = (
    members: Array<{ peerId: string | null }> = input.currentRoomRef.current?.room.members ?? []
  ) => {
    const remotePeerIds = members
      .map((member) => member.peerId)
      .filter((memberPeerId): memberPeerId is string => !!memberPeerId && memberPeerId !== input.peerId);
    void mesh.syncPeers(remotePeerIds).catch(input.reportMeshResyncFailure);
  };

  return { mesh, resyncRealtimePeers };
}
