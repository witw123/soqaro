import type {
  PeerConnectionStatsSample,
  PeerConnectionStatsSnapshot
} from "./connection-stats";
import type { PeerLinkKind } from "./signaling-transport";

export type { PeerLinkKind };

export type PeerMediaTrackState = "none" | "live" | "ended" | "failed";

export type PeerMediaState = {
  senderTrackState: PeerMediaTrackState;
  receiverTrackState: PeerMediaTrackState;
  remoteStream: MediaStream | null;
  remoteTrackId: string | null;
  receiverRtpActive: boolean;
  sourcePeerId: string | null;
};

export type PeerEntry = {
  linkKind: PeerLinkKind;
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  audioTransceiver: RTCRtpTransceiver | null;
  audioSender: RTCRtpSender | null;
  audioReceiver: RTCRtpReceiver | null;
  remoteAudioStream: MediaStream | null;
  remoteAudioTrackId: string | null;
  senderStreamId: string | null;
  senderTrackState: PeerMediaTrackState;
  configuredAudioMaxBitrateKbps: number | null;
  appliedAudioBitrateKbps: number | null;
  receiverTrackState: PeerMediaTrackState;
  receiverRtpActive: boolean;
  receiverMuteTimerId: ReturnType<typeof setTimeout> | null;
  mediaWatchdogTimerId: ReturnType<typeof setTimeout> | null;
  mediaSyncRetryTimerId: ReturnType<typeof setTimeout> | null;
  mediaSyncRetryAttempts: number;
  mediaNegotiationPending: boolean;
  /** Gate listener track-recovery offers until their cooldown expires. */
  mediaMissingTrackRecoveryAttempted: boolean;
  /** The peerId that initiated this connection (so we don't initiate twice) */
  initiatorPeerId: string | null;
  /** Monotonic id for this local RTCPeerConnection incarnation. */
  connectionGeneration: number;
  pendingCandidates: RTCIceCandidateInit[];
  statsIntervalId: ReturnType<typeof setInterval> | null;
  statsSnapshot: PeerConnectionStatsSnapshot | null;
  dataChannelState: RTCDataChannelState | null;
  createdAtMs: number;
  lastSignalProgressAtMs: number;
  reconnectAttempts: number;
  reconnectTimerId: ReturnType<typeof setTimeout> | null;
  watchdogTimerId: ReturnType<typeof setTimeout> | null;
  releasing: boolean;
  operationChain: Promise<void>;
};

export function createPeerEntry(input: {
  connection: RTCPeerConnection;
  initiatorPeerId: string | null;
  nowMs: number;
  connectionGeneration?: number;
  linkKind?: PeerLinkKind;
}): PeerEntry {
  return {
    linkKind: input.linkKind ?? "data",
    connection: input.connection,
    channel: null,
    audioTransceiver: null,
    audioSender: null,
    audioReceiver: null,
    remoteAudioStream: null,
    remoteAudioTrackId: null,
    senderStreamId: null,
    senderTrackState: "none",
    configuredAudioMaxBitrateKbps: null,
    appliedAudioBitrateKbps: null,
    receiverTrackState: "none",
    receiverRtpActive: false,
    receiverMuteTimerId: null,
    mediaWatchdogTimerId: null,
    mediaSyncRetryTimerId: null,
    mediaSyncRetryAttempts: 0,
    mediaNegotiationPending: false,
    mediaMissingTrackRecoveryAttempted: false,
    initiatorPeerId: input.initiatorPeerId,
    connectionGeneration: input.connectionGeneration ?? 1,
    pendingCandidates: [],
    statsIntervalId: null,
    statsSnapshot: null,
    dataChannelState: null,
    createdAtMs: input.nowMs,
    lastSignalProgressAtMs: input.nowMs,
    reconnectAttempts: 0,
    reconnectTimerId: null,
    watchdogTimerId: null,
    releasing: false,
    operationChain: Promise.resolve()
  };
}

export function isPeerStalled(input: {
  entry: PeerEntry;
  nowMs: number;
  dataOpenTimeoutMs: number;
  passiveNegotiationTimeoutMs?: number;
  dataConnectingTimeoutMs: number;
  connectionProgressTimeoutMs: number;
}) {
  const { entry } = input;
  const channelState = entry.channel?.readyState ?? null;
  const connectionState = entry.connection.connectionState;
  const iceConnectionState = entry.connection.iceConnectionState;
  const transportFailed = connectionState === "failed" ||
    connectionState === "closed" ||
    iceConnectionState === "failed" ||
    iceConnectionState === "closed";
  const transportDisconnected = connectionState === "disconnected" ||
    iceConnectionState === "disconnected";

  if (transportFailed) {
    return true;
  }

  // A DataChannel may stay open while ICE is disconnected. Give the browser
  // time to repair the selected pair, then recover if the transport remains
  // unusable instead of treating the stale channel as permanent health.
  if (channelState === "open" && !transportDisconnected) {
    return false;
  }

  if (
    transportDisconnected &&
    input.nowMs - entry.lastSignalProgressAtMs >= input.connectionProgressTimeoutMs
  ) {
    return true;
  }

  if (
    entry.initiatorPeerId === null &&
    channelState === null &&
    entry.connection.localDescription === null &&
    entry.connection.remoteDescription === null &&
    input.nowMs - entry.createdAtMs >=
      (input.passiveNegotiationTimeoutMs ?? input.dataOpenTimeoutMs)
  ) {
    // The deterministic offerer may not have learned this member yet. Let the
    // passive side take over after a short grace period instead of recreating
    // another passive connection forever.
    return true;
  }

  if (input.nowMs - entry.createdAtMs >= input.dataOpenTimeoutMs) {
    return true;
  }

  if (
    channelState === "connecting" &&
    input.nowMs - entry.lastSignalProgressAtMs >= input.dataConnectingTimeoutMs
  ) {
    return true;
  }

  if (
    (connectionState === "new" ||
      connectionState === "connecting" ||
      connectionState === "disconnected") &&
    input.nowMs - entry.lastSignalProgressAtMs >= input.connectionProgressTimeoutMs
  ) {
    return true;
  }

  return false;
}

export function shouldRestartPeer(input: {
  entry: PeerEntry;
  nowMs: number;
  dataOpenTimeoutMs: number;
  dataConnectingTimeoutMs: number;
  connectionProgressTimeoutMs: number;
}) {
  const { entry } = input;
  if (entry.releasing) {
    return false;
  }

  if (
    entry.connection.connectionState === "failed" ||
    entry.connection.connectionState === "closed" ||
    entry.dataChannelState === "closed"
  ) {
    return true;
  }

  return isPeerStalled(input);
}

export function clearPeerWatchdog(entry: PeerEntry) {
  if (!entry.watchdogTimerId) {
    return;
  }

  clearTimeout(entry.watchdogTimerId);
  entry.watchdogTimerId = null;
}

export function clearPeerReconnectTimer(entry: PeerEntry) {
  if (!entry.reconnectTimerId) {
    return;
  }

  clearTimeout(entry.reconnectTimerId);
  entry.reconnectTimerId = null;
}

export function clearPeerTimers(entry: PeerEntry) {
  clearPeerWatchdog(entry);
  clearPeerReconnectTimer(entry);
}

export async function flushPendingCandidates(entry: PeerEntry) {
  if (entry.pendingCandidates.length === 0) {
    return;
  }

  const nextCandidates = [...entry.pendingCandidates];
  entry.pendingCandidates = [];
  for (const candidate of nextCandidates) {
    try {
      await entry.connection.addIceCandidate(candidate);
    } catch {
      if (!entry.connection.remoteDescription) {
        entry.pendingCandidates.push(candidate);
      }
    }
  }
}

export function enqueuePeerOperation<T>(entry: PeerEntry, task: () => Promise<T>) {
  const run = entry.operationChain
    .catch(() => undefined)
    .then(async () => {
      if (entry.releasing) {
        return undefined as T;
      }
      return task();
    });
  entry.operationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function startPeerStatsSampling(input: {
  peerId: string;
  entry: PeerEntry;
  mode: "off" | "steady" | "active";
  activeStatsSamplingIntervalMs: number;
  steadyStatsSamplingIntervalMs: number;
  onStatsSample?: (payload: {
    peerId: string;
    linkKind: PeerLinkKind;
    sample: PeerConnectionStatsSample;
  }) => void;
  samplePeerConnectionStats: (
    connection: RTCPeerConnection,
    previousSnapshot: PeerConnectionStatsSnapshot | null
  ) => Promise<{
    sample: PeerConnectionStatsSample;
    snapshot: PeerConnectionStatsSnapshot;
  } | null>;
}) {
  if (!input.onStatsSample || input.entry.statsIntervalId || input.mode === "off") {
    return;
  }

  let sampleInFlight = false;
  const emitStatsSample = async () => {
    if (sampleInFlight || input.entry.releasing) {
      return;
    }
    sampleInFlight = true;
    try {
      const nextStats = await input.samplePeerConnectionStats(
        input.entry.connection,
        input.entry.statsSnapshot
      );
      if (!nextStats || input.entry.releasing) {
        return;
      }

      input.entry.statsSnapshot = nextStats.snapshot;
      input.onStatsSample?.({
        peerId: input.peerId,
        linkKind: input.entry.linkKind,
        sample: {
          ...nextStats.sample,
          connectionState: input.entry.connection.connectionState ?? nextStats.sample.connectionState ?? null,
          iceConnectionState: input.entry.connection.iceConnectionState ?? nextStats.sample.iceConnectionState ?? null,
          dataChannelState: input.entry.channel?.readyState ?? null
        }
      });
    } finally {
      sampleInFlight = false;
    }
  };

  void emitStatsSample();
  const samplingIntervalMs =
    input.mode === "steady"
      ? input.steadyStatsSamplingIntervalMs
      : input.activeStatsSamplingIntervalMs;
  input.entry.statsIntervalId = setInterval(() => {
    void emitStatsSample();
  }, samplingIntervalMs);
}

export function stopPeerStatsSampling(entry: PeerEntry) {
  if (!entry.statsIntervalId) {
    return;
  }

  clearInterval(entry.statsIntervalId);
  entry.statsIntervalId = null;
}

export class PeerConnectionRegistry {
  private readonly peers = new Map<string, Map<PeerLinkKind, PeerEntry>>();
  private readonly expectedPeerIds = new Set<string>();

  constructor(private readonly localPeerId: string) {}

  setExpectedRemotePeerIds(remotePeerIds: string[]) {
    this.expectedPeerIds.clear();
    for (const peerId of remotePeerIds) {
      if (!peerId || peerId === this.localPeerId) {
        continue;
      }
      this.expectedPeerIds.add(peerId);
    }

    return new Set(this.expectedPeerIds);
  }

  expects(peerId: string) {
    return this.expectedPeerIds.has(peerId);
  }

  clearExpected() {
    this.expectedPeerIds.clear();
  }

  get(peerId: string, linkKind: PeerLinkKind = "data") {
    return this.peers.get(peerId)?.get(linkKind) ?? null;
  }

  set(peerId: string, entry: PeerEntry, linkKind: PeerLinkKind = entry.linkKind) {
    const links = this.peers.get(peerId) ?? new Map<PeerLinkKind, PeerEntry>();
    links.set(linkKind, entry);
    this.peers.set(peerId, links);
  }

  entries(linkKind: PeerLinkKind = "data") {
    return [...this.peers.entries()]
      .map(([peerId, links]) => {
        const entry = links.get(linkKind);
        return entry ? ([peerId, entry] as [string, PeerEntry]) : null;
      })
      .filter((item): item is [string, PeerEntry] => item !== null);
  }

  allEntries() {
    return [...this.peers.entries()].flatMap(([peerId, links]) =>
      [...links.entries()].map(([linkKind, entry]) => [
        peerId,
        entry,
        linkKind
      ] as [string, PeerEntry, PeerLinkKind])
    );
  }

  deleteIfCurrent(peerId: string, entry: PeerEntry, linkKind: PeerLinkKind = entry.linkKind) {
    const links = this.peers.get(peerId);
    if (links?.get(linkKind) !== entry) {
      return false;
    }

    links.delete(linkKind);
    if (links.size === 0) {
      this.peers.delete(peerId);
    }
    return true;
  }

  clearPeers() {
    this.peers.clear();
  }

  getConnectedPeerIds() {
    return this.entries("data")
      .filter(([, entry]) => entry.channel?.readyState === "open")
      .map(([peerId]) => peerId);
  }
}
