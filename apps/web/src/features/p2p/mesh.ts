import {
  type IceServerConfig,
  type PeerSignalMessage
} from "@soqaro/shared";
import {
  type PeerConnectionStatsSample
} from "./connection-stats";
import {
  decodePeerTelemetryReport,
  encodePeerTelemetryReport,
  type PeerTelemetryReport
} from "./peer-telemetry";
import {
  SignalingTransport,
  shouldIgnoreStaleAnswerError
} from "./signaling-transport";
import { DataChannelManager } from "./data-channel-manager";
import {
  type PeerEntry
} from "./peer-connection-registry";
import { PeerConnectionLifecycleManager } from "./peer-connection-lifecycle-manager";

type MeshCallbacks = {
  onPeerConnectionChange?: (payload: {
    peerId: string;
    state: RTCPeerConnectionState;
    linkKind?: "data" | "media";
  }) => void;
  onIceConnectionStateChange?: (payload: {
    peerId: string;
    state: RTCIceConnectionState;
    linkKind?: "data" | "media";
  }) => void;
  onDataChannelStateChange?: (payload: {
    peerId: string;
    state: RTCDataChannelState;
  }) => void;
  onDataBufferedAmountChange?: (payload: {
    peerId: string;
    bufferedAmountBytes: number;
  }) => void;
  onPeerReleased?: (peerId: string, linkKind: "data" | "media") => void;
  onSignal?: (payload: {
    peerId: string;
    direction: "sent" | "received";
    type: PeerSignalMessage["type"];
  }) => void;
  onStatsSample?: (payload: {
    peerId: string;
    linkKind?: "data" | "media";
    sample: PeerConnectionStatsSample;
  }) => void;
  onPeerStalled?: (payload: {
    peerId: string;
    reason: "watchdog-timeout" | "connection-failed" | "data-channel-closed";
  }) => void;
  onRemoteAudioTrack?: (payload: {
    peerId: string;
    stream: MediaStream;
    track: MediaStreamTrack;
  }) => void;
  onMediaStateChange?: (payload: {
    peerId: string;
    direction: "sender" | "receiver";
    state: "none" | "live" | "ended" | "failed";
  }) => void;
  onMediaTrackMuted?: (payload: { peerId: string; trackId: string }) => void;
  onMediaRecovery?: (payload: {
    peerId: string;
    reason: "loss" | "jitter" | "no-packets" | "connection-failed";
    restartCount: number;
  }) => void;
  onPeerTelemetry?: (payload: {
    peerId: string;
    report: PeerTelemetryReport;
  }) => void;
};

export type RemoteAudioTrackListener = (payload: {
  peerId: string;
  stream: MediaStream;
  track: MediaStreamTrack;
}) => void;

type MeshOptions = {
  autoReconnect?: boolean;
  resolveConnectionConfig?: (peerId: string) => Partial<RTCConfiguration> | null | undefined;
};

export class P2PMesh {
  private readonly autoReconnect: boolean;
  private readonly signaling: SignalingTransport;
  private readonly peerLifecycle: PeerConnectionLifecycleManager;
  private readonly dataChannels: DataChannelManager;

  constructor(
    private readonly roomId: string,
    private readonly localPeerId: string,
    private readonly sendSignal: (payload: PeerSignalMessage) => void,
    private readonly callbacks: MeshCallbacks,
    private iceServers: IceServerConfig[] = [],
    options: MeshOptions = {}
    ) {
    this.autoReconnect = options.autoReconnect ?? true;
    this.signaling = new SignalingTransport({
      roomId: this.roomId,
      localPeerId: this.localPeerId,
      sendSignal: this.sendSignal,
      onSignal: this.callbacks.onSignal
    });
    this.dataChannels = new DataChannelManager({
      autoReconnect: this.autoReconnect,
      onDataChannelStateChange: (payload) => {
        this.callbacks.onDataChannelStateChange?.(payload);
      },
      onDataBufferedAmountChange: (payload) => {
        this.callbacks.onDataBufferedAmountChange?.(payload);
      },
      onPeerConnectionChange: this.callbacks.onPeerConnectionChange,
      onPeerStalled: this.callbacks.onPeerStalled
    });
    this.peerLifecycle = new PeerConnectionLifecycleManager({
      localPeerId: this.localPeerId,
      autoReconnect: this.autoReconnect,
      iceServers: this.iceServers,
      resolveConnectionConfig: options.resolveConnectionConfig,
      signaling: this.signaling,
      bindChannel: (peerId, entry, channel) => this.bindChannel(peerId, entry, channel),
      clearPendingRequestsForPeer: () => undefined,
      onPeerConnectionChange: this.callbacks.onPeerConnectionChange,
      onIceConnectionStateChange: this.callbacks.onIceConnectionStateChange,
      onDataBufferedAmountChange: this.callbacks.onDataBufferedAmountChange,
      onStatsSample: this.callbacks.onStatsSample,
      onPeerStalled: this.callbacks.onPeerStalled,
      onRemoteAudioTrack: ({ peerId, entry, track, streams }) => {
        const stream = entry.remoteAudioStream ?? streams[0] ?? new MediaStream([track]);
        this.callbacks.onRemoteAudioTrack?.({ peerId, stream, track });
      },
      onMediaStateChange: ({ peerId, direction, state }) => {
        this.callbacks.onMediaStateChange?.({ peerId, direction, state });
      },
      onMediaTrackMuted: this.callbacks.onMediaTrackMuted,
      onMediaRecovery: this.callbacks.onMediaRecovery,
      onPeerReleased: this.callbacks.onPeerReleased
    });
  }

  async syncPeers(
    remotePeerIds: string[],
    options?: { forceReconnectDegraded?: boolean }
  ) {
    await this.peerLifecycle.syncPeers(remotePeerIds, options);
  }

  async handleSignal(payload: PeerSignalMessage) {
    await this.signaling.handleIncomingSignal(payload, {
      getOrCreatePeerEntry: (peerId, linkKind, signalType) =>
        this.peerLifecycle.getOrCreateIncomingPeerEntry(peerId, linkKind, signalType),
      runPeerOperation: (entry, task) => this.peerLifecycle.runPeerOperation(entry, task),
      applyRemoteDescription: (entry, remoteDescription) =>
        this.applyRemoteDescription(entry, remoteDescription),
      flushPendingCandidates: (entry) => this.peerLifecycle.flushPendingCandidates(entry)
    });
  }

  setStatsSamplingMode(mode: "off" | "steady" | "active") {
    this.peerLifecycle.setStatsSamplingMode(mode);
  }

  getConnectedPeerIds() {
    return this.peerLifecycle.getConnectedPeerIds();
  }

  setLocalAudioStream(
    stream: MediaStream | null,
    sourcePeerId: string | null,
    maxBitrateKbps: number | null = null,
    mediaTrafficExpected = true,
    mediaEpoch: number | null = null
  ) {
    this.peerLifecycle.setLocalAudioStream(
      stream,
      sourcePeerId,
      maxBitrateKbps,
      mediaTrafficExpected,
      mediaEpoch
    );
  }

  setMediaPlaybackEnabled(enabled: boolean) {
    return this.peerLifecycle.setMediaPlaybackEnabled(enabled);
  }

  getPeerMediaState(peerId: string) {
    return this.peerLifecycle.getPeerMediaState(peerId);
  }

  async restartPeer(peerId: string) {
    return this.peerLifecycle.restartPeer(peerId);
  }

  async restartIce(peerId: string) {
    return this.peerLifecycle.restartIce(peerId);
  }

  /** Updates ICE servers in place without tearing down existing peer connections. */
  updateIceServers(iceServers: IceServerConfig[]) {
    this.iceServers = iceServers;
    this.peerLifecycle.updateIceServers(iceServers);
  }

  async restartMediaPeer(
    peerId: string,
    options?: { forceRecreate?: boolean; forceIceRestart?: boolean }
  ) {
    return this.peerLifecycle.restartMediaPeer(peerId, options);
  }

  sendPeerTelemetry(report: PeerTelemetryReport, targetPeerId?: string) {
    const payload = encodePeerTelemetryReport(report);
    const entries = targetPeerId
      ? [[targetPeerId, this.peerLifecycle.getPeerEntry(targetPeerId, "data")] as const]
      : this.peerLifecycle
          .getConnectedPeerIds()
          .map((peerId) => [peerId, this.peerLifecycle.getPeerEntry(peerId, "data")] as const);

    for (const [, entry] of entries) {
      const channel = entry?.channel;
      if (!channel || channel.readyState !== "open") {
        continue;
      }
      try {
        channel.send(payload);
      } catch {
        // A closed/racing channel is recovered by the mesh supervisor.
      }
    }
  }

  destroy() {
    this.peerLifecycle.destroy();
  }

  private bindChannel(peerId: string, entry: PeerEntry, channel: RTCDataChannel) {
    this.dataChannels.bind({
      peerId,
      entry,
      channel,
      schedulePeerWatchdog: () => this.peerLifecycle.schedulePeerWatchdog(peerId, entry),
      clearPendingRequestsForPeer: () => undefined,
      schedulePeerReconnect: () => this.peerLifecycle.schedulePeerReconnect(peerId, entry),
      onMessage: (event) => {
        const raw =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : null;
        const report = decodePeerTelemetryReport(raw);
        if (!report) {
          return;
        }
        this.callbacks.onPeerTelemetry?.({
          peerId,
          report
        });
      }
    });
  }

  private async applyRemoteDescription(
    entry: PeerEntry,
    remoteDescription: RTCSessionDescriptionInit
  ) {
    try {
      await entry.connection.setRemoteDescription(remoteDescription);
      if (entry.linkKind === "media") {
        const peerId = this.peerLifecycle.getPeerIdForEntry(entry);
        if (peerId) {
          await this.peerLifecycle.notifyRemoteDescriptionApplied(
            peerId,
            entry,
            remoteDescription.type === "offer" ? "offer" : "answer"
          );
        }
      }
    } catch (error) {
      if (
        remoteDescription.type === "answer" &&
        shouldIgnoreStaleAnswerError(entry.connection.signalingState, error)
      ) {
        return;
      }
      throw error;
    }
  }

}
