import type {
  IceServerConfig
} from "@soqaro/shared";
import {
  SignalingTransport,
  type PeerLinkKind,
  type SignalType
} from "./signaling-transport";
import {
  MeshHealthMonitor
} from "./mesh-health-monitor";
import {
  PeerStatsSampler
} from "./peer-stats-sampler";
import {
  PeerConnectionRegistry,
  createPeerEntry,
  enqueuePeerOperation,
  flushPendingCandidates,
  shouldRestartPeer,
  type PeerEntry,
  type PeerMediaState
} from "./peer-connection-registry";
import {
  bindPeerConnectionEvents,
  buildPeerConnectionConfig,
  releasePeerConnectionEntry,
  resolveExistingPeerConnectionAction,
  shouldInitiatePeerConnection
} from "./peer-connection-lifecycle";
import {
  samplePeerConnectionStats,
  type PeerConnectionStatsSample
} from "./connection-stats";
import {
  resolveFanoutAudioBitrateKbps,
  resolveFixedAudioBitrateKbps
} from "./audio-bitrate-policy";

type PeerStalledReason = "watchdog-timeout" | "connection-failed" | "data-channel-closed";

type PeerConnectionLifecycleManagerInput = {
  localPeerId: string;
  autoReconnect: boolean;
  iceServers: IceServerConfig[];
  resolveConnectionConfig?: (peerId: string) => Partial<RTCConfiguration> | null | undefined;
  signaling: SignalingTransport;
  bindChannel: (peerId: string, entry: PeerEntry, channel: RTCDataChannel) => void;
  clearPendingRequestsForPeer: (peerId: string) => void;
  onPeerConnectionChange?: (payload: {
    peerId: string;
    state: RTCPeerConnectionState;
    linkKind?: PeerLinkKind;
  }) => void;
  onIceConnectionStateChange?: (payload: {
    peerId: string;
    state: RTCIceConnectionState;
    linkKind?: PeerLinkKind;
  }) => void;
  onDataBufferedAmountChange?: (payload: {
    peerId: string;
    bufferedAmountBytes: number;
  }) => void;
  onPeerReleased?: (peerId: string, linkKind: PeerLinkKind) => void;
  onStatsSample?: (payload: {
    peerId: string;
    linkKind?: PeerLinkKind;
    sample: PeerConnectionStatsSample;
  }) => void;
  onPeerStalled?: (payload: {
    peerId: string;
    reason: PeerStalledReason;
  }) => void;
  onRemoteAudioTrack?: (payload: {
    peerId: string;
    entry: PeerEntry;
    track: MediaStreamTrack;
    streams: readonly MediaStream[];
  }) => void;
  onMediaStateChange?: (payload: {
    peerId: string;
    entry: PeerEntry;
    direction: "sender" | "receiver";
    state: PeerEntry["senderTrackState"];
  }) => void;
  onMediaTrackMuted?: (payload: { peerId: string; trackId: string }) => void;
  onMediaRecovery?: (payload: {
    peerId: string;
    reason: "loss" | "jitter" | "no-packets" | "connection-failed";
    restartCount: number;
  }) => void;
};

type MediaRecoveryState = {
  degradedWindows: number;
  noPacketWindows: number;
  noSendPacketWindows: number;
  lastMediaReceivePacketAtMs: number | null;
  lastMediaSendPacketAtMs: number | null;
  highLossWindows: number;
  highJitterWindows: number;
  positiveMediaWindows: number;
  lastPositiveMediaAtMs: number | null;
  restartTimesMs: number[];
  failureReportedAtMs: number | null;
  disconnectedTimerId: ReturnType<typeof setTimeout> | null;
  disconnectedSinceMs: number | null;
};

type PendingTopologySync = {
  remotePeerIds: string[];
  options?: { forceReconnectDegraded?: boolean };
  requestVersion: number;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
};

const mediaTrackWatchdogGraceMs = 3_000;
const mediaOfferAnswerTimeoutMs = 5_000;
// A media recovery is an SDP/ICE operation and can briefly replace the
// receiver's playout path. Persistent network failure must not turn this into
// a tight offer loop while the browser is still retrying ICE in place.
const mediaRecoveryCooldownMs = 8_000;
const mediaNoReceiveRecoveryWindows = 4;
const mediaNoSendRecoveryWindows = 4;
const mediaRecoveryHealthyLossThreshold = 3;
const mediaRecoveryHealthyJitterThreshold = 20;
// A single stats window can contain a burst caused by Wi-Fi contention or a
// browser scheduling pause. Require several consecutive windows before
// replacing a still-connected RTP path. At the normal 1-2s sampling cadence
// this corresponds to roughly 3-6 seconds of sustained impairment.
const mediaSustainedLossRecoveryWindows = 3;
const mediaSustainedJitterRecoveryWindows = 3;
const mediaPositiveRtpFreshMs = 4_000;
const incomingPeerAdmissionGraceMs = 8_000;
const dataPassiveNegotiationTakeoverMs = 4_000;
const mediaIceRestartAttemptsBeforeRecreate = 2;
// A source creates one media PC per listener. Give ICE/DTLS a short head start
// between new PCs so a ten-member join does not produce one signaling burst.
const mediaTopologyStaggerMs = 75;
// Data links carry room control traffic and should become usable quickly, but
// creating every RTCPeerConnection at once can flood ICE and signaling. Three
// concurrent negotiations keeps a ten-member room responsive without causing
// another candidate burst.
const dataTopologyConcurrency = 3;
const topologyRetryDelayMs = 1_500;
const receiverPlayoutDelaySeconds = 0.3;
const receiverJitterBufferTargetMs = 300;
const receiverElevatedPlayoutDelaySeconds = 0.5;
const receiverElevatedJitterBufferTargetMs = 500;
const receiverHealthyLossThreshold = 1;
const receiverHealthyJitterThreshold = 10;
// ICE can report `disconnected` while its connectivity checks are still
// repairing the selected candidate pair. Re-offering during that window
// replaces a usable RTP path and is much more disruptive than the outage.
const mediaDisconnectedRecoveryDelayMs = 10_000;
// Some WebKit builds expose a live receiver track but omit comparable RTP
// counters. That is useful as a short grace signal, not as permanent proof
// that a disconnected transport is healthy.
const mediaDisconnectedWithoutStatsMaxWaitMs = 20_000;

function createMediaRecoveryState(): MediaRecoveryState {
  return {
    degradedWindows: 0,
    noPacketWindows: 0,
    noSendPacketWindows: 0,
    lastMediaReceivePacketAtMs: null,
    lastMediaSendPacketAtMs: null,
    highLossWindows: 0,
    highJitterWindows: 0,
    positiveMediaWindows: 0,
    lastPositiveMediaAtMs: null,
    restartTimesMs: [],
    failureReportedAtMs: null,
    disconnectedTimerId: null,
    disconnectedSinceMs: null
  };
}

export class PeerConnectionLifecycleManager {
  private readonly peerConnections: PeerConnectionRegistry;
  private readonly healthMonitor: MeshHealthMonitor;
  private readonly statsSampler: PeerStatsSampler;
  private readonly localPeerId: string;
  private readonly autoReconnect: boolean;
  private iceServers: IceServerConfig[];
  private readonly resolveConnectionConfig?: PeerConnectionLifecycleManagerInput["resolveConnectionConfig"];
  private readonly signaling: SignalingTransport;
  private readonly bindChannelCallback: PeerConnectionLifecycleManagerInput["bindChannel"];
  private readonly clearPendingRequestsForPeerCallback: PeerConnectionLifecycleManagerInput["clearPendingRequestsForPeer"];
  private readonly onPeerConnectionChange?: PeerConnectionLifecycleManagerInput["onPeerConnectionChange"];
  private readonly onIceConnectionStateChange?: PeerConnectionLifecycleManagerInput["onIceConnectionStateChange"];
  private readonly onDataBufferedAmountChange?: PeerConnectionLifecycleManagerInput["onDataBufferedAmountChange"];
  private readonly onPeerReleased: PeerConnectionLifecycleManagerInput["onPeerReleased"];
  private readonly onPeerStalled?: PeerConnectionLifecycleManagerInput["onPeerStalled"];
  private readonly onRemoteAudioTrack?: PeerConnectionLifecycleManagerInput["onRemoteAudioTrack"];
  private readonly onMediaStateChange?: PeerConnectionLifecycleManagerInput["onMediaStateChange"];
  private readonly onMediaTrackMuted?: PeerConnectionLifecycleManagerInput["onMediaTrackMuted"];
  private readonly onMediaRecovery?: PeerConnectionLifecycleManagerInput["onMediaRecovery"];
  private readonly mediaRecovery = new Map<string, MediaRecoveryState>();
  private readonly latestMediaSamples = new Map<string, PeerConnectionStatsSample>();
  private readonly elevatedReceiverBufferEntries = new WeakSet<PeerEntry>();
  private readonly mediaRecoveryOperations = new Map<string, {
    intentGeneration: number;
    operation: Promise<PeerEntry | null>;
  }>();
  private readonly provisionalIncomingAdmissionTimers = new WeakMap<
    PeerEntry,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingIncomingAdmissionKeys = new Set<string>();
  private connectionGenerationSequence = 0;
  private localAudioStream: MediaStream | null = null;
  private localAudioSourcePeerId: string | null = null;
  private localAudioMaxBitrateKbps: number | null = null;
  private localPlaybackMediaEpoch: number | null = null;
  // RTP recovery must follow playback intent. A live MediaStream can carry
  // deliberate silence while a room is paused, which is not a broken link.
  private localMediaTrafficExpected = true;
  private mediaIntentGeneration = 0;
  // Data links remain room-wide, but a listener playing a local cache must
  // not keep an RTP receiver for the source alive in the background.
  private mediaPlaybackEnabled = true;
  private expectedRemotePeerIds = new Set<string>();
  // Before the first authoritative member snapshot arrives, an incoming offer
  // can legitimately beat topology reconciliation. Once initialized, only
  // explicitly expected peers may allocate a new RTCPeerConnection.
  private topologyInitialized = false;
  private topologyOperationChain: Promise<void> = Promise.resolve();
  private pendingTopologySync: PendingTopologySync | null = null;
  private topologySyncDrainScheduled = false;
  private topologySyncRequestVersion = 0;
  private topologyRetryTimerId: ReturnType<typeof setTimeout> | null = null;
  private topologyRetryRequestVersion: number | null = null;
  private destroyed = false;

  constructor(input: PeerConnectionLifecycleManagerInput) {
    this.localPeerId = input.localPeerId;
    this.autoReconnect = input.autoReconnect;
    this.iceServers = input.iceServers;
    this.resolveConnectionConfig = input.resolveConnectionConfig;
    this.signaling = input.signaling;
    this.bindChannelCallback = input.bindChannel;
    this.clearPendingRequestsForPeerCallback = input.clearPendingRequestsForPeer;
    this.onPeerConnectionChange = input.onPeerConnectionChange;
    this.onIceConnectionStateChange = input.onIceConnectionStateChange;
    this.onDataBufferedAmountChange = input.onDataBufferedAmountChange;
    this.onPeerReleased = input.onPeerReleased;
    this.onPeerStalled = input.onPeerStalled;
    this.onRemoteAudioTrack = input.onRemoteAudioTrack;
    this.onMediaStateChange = input.onMediaStateChange;
    this.onMediaTrackMuted = input.onMediaTrackMuted;
    this.onMediaRecovery = input.onMediaRecovery;
    this.peerConnections = new PeerConnectionRegistry(input.localPeerId);
    this.statsSampler = new PeerStatsSampler({
      // Media health needs a short cadence for no-packet detection. Data
      // transport state is already event-driven, so its getStats cadence can
      // be much lower when a room has many peer connections.
      activeStatsSamplingIntervalMs: 3_000,
      steadyStatsSamplingIntervalMs: 5_000,
      activeMediaStatsSamplingIntervalMs: 1_000,
      steadyMediaStatsSamplingIntervalMs: 2_000,
      shouldSampleEntry: (peerId, entry) =>
        entry.linkKind !== "media" || this.shouldSampleMediaStats(peerId),
      onStatsSample: (payload) => {
        const mediaEntry = this.peerConnections.get(payload.peerId, "media");
        const isMediaSample = payload.linkKind === "media" && !!mediaEntry;
        if (isMediaSample) {
          this.latestMediaSamples.set(payload.peerId, payload.sample);
        }
        const configured = this.peerConnections.get(payload.peerId, "media")?.configuredAudioMaxBitrateKbps ??
          this.peerConnections.get(payload.peerId)?.configuredAudioMaxBitrateKbps ?? null;
        input.onStatsSample?.({
          peerId: payload.peerId,
          linkKind: payload.linkKind,
          sample: {
            ...payload.sample,
            configuredAudioMaxBitrateKbps: configured
          }
        });
        if (isMediaSample) {
          this.observeMediaHealth(payload.peerId, payload.sample);
        }
      },
      samplePeerConnectionStats
    });
    this.healthMonitor = new MeshHealthMonitor({
      autoReconnect: input.autoReconnect,
      reconnectBackoffMs: [1_000, 2_000, 4_000, 8_000],
      dataOpenTimeoutMs: 8_000,
      passiveNegotiationTimeoutMs: dataPassiveNegotiationTakeoverMs,
      dataConnectingTimeoutMs: 12_000,
      connectionProgressTimeoutMs: 15_000,
      isExpectedPeer: (peerId) => this.peerConnections.expects(peerId),
      getPeerEntry: (peerId) => this.peerConnections.get(peerId),
      onPeerStalled: input.onPeerStalled,
      releasePeer: (peerId, entry) => this.releasePeer(peerId, entry),
      recreatePeer: async (peerId, entry) => {
        try {
          return await this.enqueueTopologyOperation(() =>
            this.recreatePeerNow(peerId, entry, { forceInitiate: true })
          );
        } catch {
          // recreatePeerNow releases the failed entry before allocating its
          // replacement. If allocation or the first offer fails, no watchdog
          // remains to retry it, so put the peer back through topology repair.
          this.scheduleTopologyRetry();
          return null;
        }
      }
    });
  }

  syncPeers(
    remotePeerIds: string[],
    options?: { forceReconnectDegraded?: boolean }
  ) {
    if (this.destroyed) {
      return Promise.resolve();
    }

    const requestVersion = ++this.topologySyncRequestVersion;
    const normalizedPeerIds = [...new Set(remotePeerIds.filter(Boolean))];
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingTopologySync;
      if (pending) {
        // Presence, snapshot, and subscribe acknowledgements can all describe
        // the same room transition. Keep only the newest member list and let
        // every caller waiting on the superseded request complete together.
        pending.remotePeerIds = normalizedPeerIds;
        pending.options = {
          forceReconnectDegraded: Boolean(
            pending.options?.forceReconnectDegraded || options?.forceReconnectDegraded
          )
        };
        pending.requestVersion = requestVersion;
        pending.waiters.push({ resolve, reject });
      } else {
        this.pendingTopologySync = {
          remotePeerIds: normalizedPeerIds,
          options,
          requestVersion,
          waiters: [{ resolve, reject }]
        };
      }
      this.scheduleTopologySyncDrain();
    });
  }

  private scheduleTopologySyncDrain() {
    if (this.destroyed || this.topologySyncDrainScheduled) {
      return;
    }
    this.topologySyncDrainScheduled = true;
    const operation = this.enqueueTopologyOperation(async () => {
      this.topologySyncDrainScheduled = false;
      const pending = this.pendingTopologySync;
      this.pendingTopologySync = null;
      if (!pending) {
        return;
      }

      try {
        await this.syncPeersNow(
          pending.remotePeerIds,
          pending.options,
          pending.requestVersion
        );
        for (const waiter of pending.waiters) {
          waiter.resolve();
        }
      } catch (error) {
        for (const waiter of pending.waiters) {
          waiter.reject(error);
        }
      } finally {
        // A newer request may have arrived while the current topology was
        // negotiating. Schedule it after this operation so stale cleanup
        // cannot overtake the latest member list.
        if (this.pendingTopologySync) {
          this.scheduleTopologySyncDrain();
        }
      }
    });
    void operation.catch(() => undefined);
  }

  private async syncPeersNow(
    remotePeerIds: string[],
    options?: { forceReconnectDegraded?: boolean },
    requestVersion = this.topologySyncRequestVersion
  ) {
    // A newer snapshot can arrive while this operation is waiting behind a
    // media recovery. Do not briefly publish its obsolete member list before
    // the latest-only drain gets a chance to run.
    if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
      return;
    }
    const nextPeers = this.peerConnections.setExpectedRemotePeerIds(remotePeerIds);
    this.expectedRemotePeerIds = nextPeers;
    this.topologyInitialized = true;

    const dataPeerIds = [...nextPeers];
    for (let offset = 0; offset < dataPeerIds.length; offset += dataTopologyConcurrency) {
      if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
        return;
      }
      const batch = dataPeerIds.slice(offset, offset + dataTopologyConcurrency);
      await Promise.all(batch.map(async (peerId) => {
        try {
          if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
            return;
          }
          let existing = this.peerConnections.get(peerId, "data");
          const reconnectDegraded = existing &&
            (options?.forceReconnectDegraded || this.shouldRestartPeerEntry(existing));
          if (existing && reconnectDegraded) {
            await this.recreatePeerNow(peerId, existing, {
              forceInitiate: true
            });
            existing = this.peerConnections.get(peerId, "data");
          }

          if (!existing) {
            await this.ensurePeer(peerId, this.shouldInitiatePeer(peerId), "data");
          }

          const dataEntry = this.peerConnections.get(peerId, "data");
          if (dataEntry) {
            this.schedulePeerWatchdog(peerId, dataEntry);
          }
        } catch {
          // A failed member negotiation must not block the remaining batch;
          // schedule a room-wide retry because no entry remains for a
          // watchdog to observe.
          this.scheduleTopologyRetry(requestVersion);
        }
      }));
    }

    if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
      return;
    }

    for (const [peerId, entry] of this.peerConnections.allEntries()) {
      const expected = entry.linkKind === "data"
        ? nextPeers.has(peerId)
        : this.expectedMediaPeerIds().has(peerId);
      if (expected) {
        this.clearProvisionalIncomingAdmission(entry);
      }
      if (
        !expected &&
        !this.hasProvisionalIncomingAdmission(entry) &&
        !this.pendingIncomingAdmissionKeys.has(
          this.incomingAdmissionKey(peerId, entry.linkKind)
        )
      ) {
        this.releasePeer(peerId, entry);
      }
    }

    if (requestVersion !== this.topologySyncRequestVersion) {
      return;
    }
    await this.reconcileMediaTopology(requestVersion);
  }

  private enqueueTopologyOperation<T>(task: () => Promise<T>) {
    const operation = this.topologyOperationChain.then(task, task);
    this.topologyOperationChain = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private scheduleTopologyRetry(requestVersion = this.topologySyncRequestVersion) {
    if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
      return;
    }
    this.topologyRetryRequestVersion = requestVersion;
    if (this.topologyRetryTimerId !== null) {
      return;
    }
    this.topologyRetryTimerId = setTimeout(() => {
      this.topologyRetryTimerId = null;
      const retryVersion = this.topologyRetryRequestVersion;
      this.topologyRetryRequestVersion = null;
      if (
        this.destroyed ||
        retryVersion === null ||
        retryVersion !== this.topologySyncRequestVersion ||
        this.expectedRemotePeerIds.size === 0
      ) {
        return;
      }
      void this.syncPeers([...this.expectedRemotePeerIds]).catch(() => {
        this.scheduleTopologyRetry(this.topologySyncRequestVersion);
      });
    }, topologyRetryDelayMs);
  }

  private expectedMediaPeerIds() {
    if (!this.mediaPlaybackEnabled) {
      return new Set<string>();
    }
    // A listener only needs the current source's receiver. Keeping a media PC
    // for every room member turns a ten-person room into a second full mesh;
    // it also makes ICE/DTLS contention look like a source-side RTP failure.
    // The source still retains one sender PC per expected listener.
    return this.activeMediaPeerIds();
  }

  private activeMediaPeerIds() {
    const active = new Set<string>();
    if (this.localAudioSourcePeerId === this.localPeerId) {
      for (const peerId of this.expectedRemotePeerIds) {
        active.add(peerId);
      }
      return active;
    }

    if (
      this.localAudioSourcePeerId !== null &&
      this.expectedRemotePeerIds.has(this.localAudioSourcePeerId)
    ) {
      active.add(this.localAudioSourcePeerId);
    }
    return active;
  }

  private isIncomingPeerAdmitted(
    peerId: string,
    linkKind: PeerLinkKind,
    signalType?: SignalType
  ) {
    if (linkKind === "media" && !this.mediaPlaybackEnabled) {
      return false;
    }
    if (!this.topologyInitialized) {
      return true;
    }
    // The playback snapshot can identify the active source before the member
    // presence update adds that source to expectedRemotePeerIds. Do not drop
    // its first media offer in that window; the provisional admission below
    // will be promoted when topology catches up or released on timeout.
    if (
      linkKind === "media" &&
      this.localAudioSourcePeerId !== null &&
      this.localAudioSourcePeerId === peerId
    ) {
      return true;
    }
    if (!this.expectedRemotePeerIds.has(peerId)) {
      if (linkKind === "data") {
        // A member-presence patch can be missed while a joining peer already
        // knows the full room from its subscribe acknowledgement. Admit only
        // the negotiation-start signals long enough for the room snapshot
        // repair to verify membership; stale answers remain rejected.
        return signalType === "offer" || signalType === "candidate";
      }
      // On a late join, the source offer can arrive before either the
      // playback snapshot or the member presence patch. Keep this exception
      // limited to media negotiation signals and only while no source is
      // known; stale answers remain strictly topology-bound.
      return linkKind === "media" &&
        this.localAudioSourcePeerId === null &&
        (signalType === "offer" || signalType === "candidate");
    }
    if (linkKind === "data") {
      return true;
    }

    // A newly joined listener can receive the source's media offer before its
    // playback snapshot has populated localAudioSourcePeerId. Admit media
    // signals from known room members during that short window; once a source
    // is known, keep the active-source admission check strict.
    return this.localAudioSourcePeerId === null || this.activeMediaPeerIds().has(peerId);
  }

  private hasLiveLocalAudioTrack() {
    return !!this.localAudioStream?.getAudioTracks().some((track) => track.readyState === "live");
  }

  private incomingAdmissionKey(peerId: string, linkKind: PeerLinkKind) {
    return `${peerId}:${linkKind}`;
  }

  private isExpectedPeerLink(peerId: string, linkKind: PeerLinkKind) {
    return linkKind === "data"
      ? this.expectedRemotePeerIds.has(peerId)
      : this.expectedMediaPeerIds().has(peerId);
  }

  private provisionallyAdmitIncomingPeer(peerId: string, entry: PeerEntry) {
    this.clearProvisionalIncomingAdmission(entry);
    const timer = setTimeout(() => {
      this.provisionalIncomingAdmissionTimers.delete(entry);
      if (
        entry.releasing ||
        this.peerConnections.get(peerId, entry.linkKind) !== entry ||
        this.isExpectedPeerLink(peerId, entry.linkKind)
      ) {
        return;
      }
      this.releasePeer(peerId, entry);
    }, incomingPeerAdmissionGraceMs);
    this.provisionalIncomingAdmissionTimers.set(entry, timer);
  }

  private hasProvisionalIncomingAdmission(entry: PeerEntry) {
    return this.provisionalIncomingAdmissionTimers.has(entry);
  }

  private clearProvisionalIncomingAdmission(entry: PeerEntry) {
    const timer = this.provisionalIncomingAdmissionTimers.get(entry);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.provisionalIncomingAdmissionTimers.delete(entry);
    }
  }

  private async reconcileMediaTopology(requestVersion = this.topologySyncRequestVersion) {
    if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
      return;
    }
    const expectedMedia = this.expectedMediaPeerIds();
    for (const [peerId, entry] of this.peerConnections.entries("media")) {
      if (expectedMedia.has(peerId)) {
        this.clearProvisionalIncomingAdmission(entry);
      } else if (
        !this.hasProvisionalIncomingAdmission(entry) &&
        !this.pendingIncomingAdmissionKeys.has(
          this.incomingAdmissionKey(peerId, "media")
        )
      ) {
        this.releasePeer(peerId, entry);
      }
    }

    let lastCreatedMediaPeerAtMs: number | null = null;
    for (const peerId of expectedMedia) {
      if (this.destroyed || requestVersion !== this.topologySyncRequestVersion) {
        return;
      }
      const isNewMediaPeer = !this.peerConnections.get(peerId, "media");
      if (isNewMediaPeer && lastCreatedMediaPeerAtMs !== null) {
        const elapsedMs = Date.now() - lastCreatedMediaPeerAtMs;
        const remainingMs = mediaTopologyStaggerMs - elapsedMs;
        if (remainingMs > 0 && typeof window !== "undefined") {
          await new Promise((resolve) => setTimeout(resolve, remainingMs));
        }
      }
      if (
        this.destroyed ||
        requestVersion !== this.topologySyncRequestVersion ||
        !this.expectedMediaPeerIds().has(peerId)
      ) {
        continue;
      }
      let entry: PeerEntry;
      try {
        entry = await this.ensurePeer(peerId, this.shouldInitiatePeer(peerId), "media");
      } catch {
        // Media negotiation is independent per listener. Leave the failed
        // member to the shared topology retry without delaying the rest of
        // the room topology.
        this.scheduleTopologyRetry(requestVersion);
        continue;
      }
      if (requestVersion !== this.topologySyncRequestVersion) {
        return;
      }
      if (isNewMediaPeer) {
        lastCreatedMediaPeerAtMs = Date.now();
      }
      this.scheduleMediaWatchdog(peerId, entry);
      await this.enqueueMediaOperation(peerId, entry).catch(() => undefined);
      if (requestVersion !== this.topologySyncRequestVersion) {
        return;
      }
      this.syncMediaStatsSampling(peerId, entry);
    }
  }

  private shouldSampleMediaStats(peerId: string) {
    if (!this.mediaPlaybackEnabled) {
      return false;
    }

    if (this.localAudioSourcePeerId === this.localPeerId) {
      // A source has one active RTP sender per room member. Do not spend
      // stats work on prewarmed media peers before the broadcast track exists.
      return this.hasLiveLocalAudioTrack() && this.expectedRemotePeerIds.has(peerId);
    }

    // A listener only consumes RTP from the authoritative source. Other media
    // peers may stay prewarmed for a source handoff, but have no media traffic
    // to measure until they become the source.
    return this.localAudioSourcePeerId === peerId &&
      this.expectedRemotePeerIds.has(peerId);
  }

  private syncMediaStatsSampling(peerId: string, entry: PeerEntry) {
    if (entry.linkKind !== "media") {
      return;
    }
    if (this.shouldSampleMediaStats(peerId)) {
      this.statsSampler.start(peerId, entry);
    } else {
      this.statsSampler.stop(entry);
    }
  }

  getPeerEntry(peerId: string, linkKind: PeerLinkKind = "data") {
    return this.peerConnections.get(peerId, linkKind);
  }

  getPeerIdForEntry(entry: PeerEntry) {
    return this.peerConnections.allEntries().find(([, currentEntry]) => currentEntry === entry)?.[0] ?? null;
  }

  getConnectedPeerIds() {
    return this.peerConnections.getConnectedPeerIds();
  }

  getPeerMediaState(peerId: string): PeerMediaState | null {
    if (!this.mediaPlaybackEnabled) {
      return null;
    }
    const entry = this.peerConnections.get(peerId, "media");
    if (!entry) {
      return null;
    }
    this.recoverRemoteAudioTrackFromReceiver(entry);
    const remoteTrack = entry.audioReceiver?.track ??
      entry.remoteAudioStream?.getAudioTracks()[0] ??
      null;
    const receiverTrackState = entry.receiverTrackState === "failed" &&
      remoteTrack?.readyState === "live"
      ? "live"
      : entry.receiverTrackState;
    return {
      senderTrackState: entry.senderTrackState,
      // A muted receiver track is still usable. Keep the audio element bound
      // to it while RTP recovers so Chromium can use its jitter buffer instead
      // of entering the missing-track path for every loss burst.
      receiverTrackState,
      remoteStream: entry.remoteAudioStream,
      remoteTrackId: entry.remoteAudioTrackId,
      receiverRtpActive: entry.receiverRtpActive,
      sourcePeerId: entry.remoteAudioStream ? peerId : null
    };
  }

  setLocalAudioStream(
    stream: MediaStream | null,
    sourcePeerId: string | null,
    maxBitrateKbps: number | null = null,
    mediaTrafficExpected = true,
    mediaEpoch: number | null = null
  ) {
    if (this.destroyed) {
      return;
    }
    const normalizedBitrateKbps = normalizeAudioBitrateKbps(maxBitrateKbps);
    const previousTrack = this.localAudioStream?.getAudioTracks()[0] ?? null;
    const nextTrack = stream?.getAudioTracks()[0] ?? null;
    const playbackIntentChanged =
      this.localAudioSourcePeerId !== sourcePeerId ||
      this.localPlaybackMediaEpoch !== mediaEpoch;
    if (
      this.localAudioStream === stream &&
      this.localAudioSourcePeerId === sourcePeerId &&
      this.localAudioMaxBitrateKbps === normalizedBitrateKbps &&
      this.localMediaTrafficExpected === mediaTrafficExpected &&
      this.localPlaybackMediaEpoch === mediaEpoch &&
      previousTrack === nextTrack &&
      (nextTrack === null || nextTrack.readyState === "live")
    ) {
      return;
    }
    this.localAudioStream = stream;
    this.localAudioSourcePeerId = sourcePeerId;
    this.localAudioMaxBitrateKbps = normalizedBitrateKbps;
    this.localMediaTrafficExpected = mediaTrafficExpected;
    this.localPlaybackMediaEpoch = mediaEpoch;
    this.mediaIntentGeneration += 1;
    if (playbackIntentChanged) {
      this.resetMediaRecoveryForIntentChange();
    }
    const requestVersion = this.topologySyncRequestVersion;
    void this.enqueueTopologyOperation(() => this.reconcileMediaTopology(requestVersion)).catch(() => undefined);
  }

  setMediaPlaybackEnabled(enabled: boolean) {
    if (this.destroyed || this.mediaPlaybackEnabled === enabled) {
      return Promise.resolve();
    }

    this.mediaPlaybackEnabled = enabled;
    this.mediaIntentGeneration += 1;
    this.resetMediaRecoveryForIntentChange();
    const requestVersion = this.topologySyncRequestVersion;
    return this.enqueueTopologyOperation(() => this.reconcileMediaTopology(requestVersion)).catch(() => undefined);
  }

  private resetMediaRecoveryForIntentChange() {
    for (const state of this.mediaRecovery.values()) {
      if (state.disconnectedTimerId !== null) {
        clearTimeout(state.disconnectedTimerId);
      }
    }
    this.mediaRecovery.clear();
    this.latestMediaSamples.clear();
    for (const [, entry] of this.peerConnections.entries("media")) {
      entry.mediaMissingTrackRecoveryAttempted = false;
      this.clearMediaWatchdog(entry);
      this.clearMediaSyncRetry(entry);
    }
  }

  async getOrCreatePeerEntry(peerId: string, linkKind: PeerLinkKind = "data") {
    return this.peerConnections.get(peerId, linkKind) ??
      (await this.ensurePeer(peerId, false, linkKind));
  }

  async getOrCreateIncomingPeerEntry(
    peerId: string,
    linkKind: PeerLinkKind = "data",
    signalType?: SignalType
  ): Promise<PeerEntry | null> {
    if (this.destroyed || !this.isIncomingPeerAdmitted(peerId, linkKind, signalType)) {
      return null;
    }

    const existing = this.peerConnections.get(peerId, linkKind);
    if (existing && !existing.releasing) {
      return existing;
    }

    const shouldProvisionallyAdmit = !this.isExpectedPeerLink(peerId, linkKind);
    const admissionKey = this.incomingAdmissionKey(peerId, linkKind);
    if (shouldProvisionallyAdmit) {
      // ensurePeer is async and yields even when it only allocates the local
      // RTCPeerConnection. Mark the peer before that yield so a concurrent
      // topology reconcile cannot release the entry before its timer exists.
      this.pendingIncomingAdmissionKeys.add(admissionKey);
    }
    try {
      const entry = await this.ensurePeer(peerId, false, linkKind);
      if (shouldProvisionallyAdmit && !entry.releasing) {
        this.provisionallyAdmitIncomingPeer(peerId, entry);
      }
      return entry;
    } finally {
      if (shouldProvisionallyAdmit) {
        this.pendingIncomingAdmissionKeys.delete(admissionKey);
      }
    }
  }

  runPeerOperation<T>(entry: PeerEntry, task: () => Promise<T>) {
    return enqueuePeerOperation(entry, task);
  }

  async flushPendingCandidates(entry: PeerEntry) {
    await flushPendingCandidates(entry);
  }

  setStatsSamplingMode(mode: "off" | "steady" | "active") {
    this.statsSampler.setMode(mode, this.peerConnections.allEntries().map(([peerId, entry]) => [peerId, entry] as [string, PeerEntry]));
  }

  async restartPeer(peerId: string) {
    try {
      return await this.enqueueTopologyOperation(() => this.restartPeerNow(peerId));
    } catch {
      this.scheduleTopologyRetry();
      return null;
    }
  }

  private async restartPeerNow(peerId: string) {
    const entry = this.peerConnections.get(peerId, "data");
    if (!entry) {
      if (!this.peerConnections.expects(peerId)) {
        return null;
      }
      return this.ensurePeer(peerId, true, "data");
    }

    return this.recreatePeerNow(peerId, entry, { forceInitiate: true });
  }

  /** Updates the ICE server list in place for active and future peer connections. */
  updateIceServers(nextIceServers: IceServerConfig[]) {
    this.iceServers = nextIceServers;
    for (const [peerId, entry] of this.peerConnections.allEntries()) {
      if (entry.releasing) {
        continue;
      }
      try {
        entry.connection.setConfiguration?.(
          buildPeerConnectionConfig({
            peerId,
            iceServers: this.iceServers,
            resolveConnectionConfig: this.resolveConnectionConfig
          })
        );
      } catch {
        // Ignore browser restrictions on active connections; new connections still use updated iceServers.
      }
    }
  }

  async restartIce(peerId: string) {
    return this.enqueueTopologyOperation(() => this.restartIceNow(peerId));
  }

  private async restartIceNow(peerId: string) {
    const entry = this.peerConnections.get(peerId, "data");
    if (!entry || entry.releasing) {
      return null;
    }
    return enqueuePeerOperation(entry, async () => {
      if (entry.releasing || entry.connection.signalingState !== "stable") {
        return null;
      }
      await this.signaling.createAndSendOffer(
        peerId,
        entry.connection,
        { iceRestart: true },
        "data",
        entry.connectionGeneration
      );
      entry.lastSignalProgressAtMs = Date.now();
      return entry;
    });
  }

  async restartMediaPeer(
    peerId: string,
    options?: { forceRecreate?: boolean; forceIceRestart?: boolean }
  ) {
    const intentGeneration = this.mediaIntentGeneration;
    const inFlight = this.mediaRecoveryOperations.get(peerId);
    if (inFlight?.intentGeneration === intentGeneration) {
      return inFlight.operation;
    }

    // Topology reconciliation and media recovery both replace entries. Keep
    // them on one queue so a recovery cannot recreate a peer that a concurrent
    // source/topology update is about to release.
    const operation = this.enqueueTopologyOperation(() =>
      this.restartMediaPeerNow(peerId, options, intentGeneration)
    );
    const recoveryOperation = { intentGeneration, operation };
    this.mediaRecoveryOperations.set(peerId, recoveryOperation);
    try {
      return await operation;
    } finally {
      if (this.mediaRecoveryOperations.get(peerId) === recoveryOperation) {
        this.mediaRecoveryOperations.delete(peerId);
      }
    }
  }

  private async restartMediaPeerNow(
    peerId: string,
    options: { forceRecreate?: boolean; forceIceRestart?: boolean } | undefined,
    intentGeneration: number
  ) {
    if (this.destroyed || intentGeneration !== this.mediaIntentGeneration) {
      return null;
    }
    const entry = this.peerConnections.get(peerId, "media");
    if (!this.expectedMediaPeerIds().has(peerId)) {
      if (entry) {
        this.releasePeer(peerId, entry);
      }
      return null;
    }
    if (!entry || entry.releasing) {
      // A forced recovery-created media peer must actively announce itself;
      // a normal topology repair stays passive and lets the current source
      // create the first offer with its real audio track.
      const allowEmptyMediaOffer = options?.forceRecreate === true;
      const recoveryInitiator = allowEmptyMediaOffer
        ? true
        : this.shouldInitiatePeer(peerId);
      return this.ensurePeer(peerId, recoveryInitiator, "media", allowEmptyMediaOffer);
    }

    const now = Date.now();
    const staleSignal =
      now - entry.lastSignalProgressAtMs >= mediaOfferAnswerTimeoutMs;
    const waitingForExpectedTrack = this.hasExpectedRemoteAudioTrack(peerId) &&
      entry.receiverTrackState !== "live";
    const hasMediaDescription = entry.connection.remoteDescription !== null ||
      entry.connection.localDescription !== null;
    const missingExpectedTrack = waitingForExpectedTrack &&
      now - entry.lastSignalProgressAtMs >= mediaTrackWatchdogGraceMs;
    // forceRecreate may announce a replacement peer, but a missing remote
    // track alone must never recreate with an empty listener offer. That path
    // races the source track offer and recreates the sound/silence loop.
    const isLocalSource = this.localAudioSourcePeerId === this.localPeerId;
    const allowEmptyMediaOffer = options?.forceRecreate === true;
    const recoveryInitiator = allowEmptyMediaOffer
      ? true
      : this.shouldInitiatePeer(peerId);
    const mediaTransportFailed =
      entry.connection.connectionState === "failed" ||
      entry.connection.iceConnectionState === "failed";
    const mediaTransportClosed =
      entry.connection.connectionState === "closed" ||
      entry.connection.iceConnectionState === "closed" ||
      entry.connection.signalingState === "closed";
    if (options?.forceRecreate || mediaTransportClosed) {
      const reconnectAttempts = entry.reconnectAttempts;
      this.releasePeer(peerId, entry);
      const nextEntry = await this.ensurePeer(peerId, recoveryInitiator, "media", allowEmptyMediaOffer);
      nextEntry.reconnectAttempts = reconnectAttempts + 1;
      return nextEntry;
    }

    if (mediaTransportFailed || options?.forceIceRestart) {
      // A failed or persistently lossy ICE transport does not invalidate the
      // negotiated media section or its sender/receiver track. Restart ICE on
      // this incarnation first so both peers keep the same RTP identity and
      // jitter buffer.
      return this.restartMediaIceInPlace(peerId, entry);
    }

    // Let the initial offer/answer exchange finish before creating another
    // offer. The media watchdog will retry once the track grace expires.
    if (waitingForExpectedTrack && !missingExpectedTrack) {
      this.scheduleMediaWatchdog(peerId, entry);
      return entry;
    }

    if (waitingForExpectedTrack && !hasMediaDescription) {
      // Wait for the active source to announce the first real media offer.
      // Recovery offers are only valid after this PeerConnection has a
      // negotiated media description to repair.
      this.scheduleMediaWatchdog(peerId, entry);
      return entry;
    }

    if (
      waitingForExpectedTrack &&
      entry.mediaMissingTrackRecoveryAttempted &&
      Date.now() - entry.lastSignalProgressAtMs < mediaOfferAnswerTimeoutMs
    ) {
      // Give the source time to answer the recovery offer before retrying.
      // A permanent one-shot latch leaves a listener waiting forever when one
      // signaling message is lost; the cooldown prevents offer glare.
      this.scheduleMediaWatchdog(peerId, entry);
      return entry;
    }

    if (
      entry.connection.signalingState !== "stable" &&
      staleSignal
    ) {
      // An unanswered recovery offer is not proof that the local media PC is
      // unusable. Roll it back and issue the next bounded ICE restart on the
      // same incarnation; triggerMediaRecovery owns the recreate threshold.
      return this.restartMediaIceInPlace(peerId, entry);
    }

    // Connected (or stable) but still missing the remote track: never recreate
    // the PeerConnection. Soft re-offers keep ICE/DTLS and the polite-peer
    // rollback path absorbs offer glare with the source.
    return enqueuePeerOperation(entry, async () => {
      if (entry.releasing || entry.connection.signalingState !== "stable") {
        return null;
      }

      const mediaTransportNeedsIceRestart =
        entry.connection.connectionState !== "connected" ||
        entry.connection.iceConnectionState === "disconnected" ||
        entry.connection.iceConnectionState === "failed";
      if (mediaTransportNeedsIceRestart || options?.forceIceRestart) {
        return this.restartMediaIceInPlace(peerId, entry, { alreadyQueued: true });
      }
      if (isLocalSource) {
        await this.syncLocalAudioToPeer(peerId, entry, true);
      } else {
        await this.signaling.createAndSendOffer(
          peerId,
          entry.connection,
          { iceRestart: Boolean(entry.connection.remoteDescription) },
          "media",
          entry.connectionGeneration
        );
        if (waitingForExpectedTrack) {
          entry.mediaMissingTrackRecoveryAttempted = true;
        }
        this.noteMediaOfferSent(peerId, entry);
      }
      this.scheduleMediaWatchdog(peerId, entry);
      return entry;
    });
  }

  private restartMediaIceInPlace(
    peerId: string,
    entry: PeerEntry,
    options?: { alreadyQueued?: boolean }
  ): Promise<PeerEntry | null> {
    const restart = async () => {
      if (
        entry.releasing ||
        this.peerConnections.get(peerId, "media") !== entry ||
        entry.connection.connectionState === "closed" ||
        entry.connection.signalingState === "closed"
      ) {
        return null;
      }

      if (entry.connection.signalingState !== "stable") {
        const staleOffer = entry.connection.signalingState === "have-local-offer" &&
          Date.now() - entry.lastSignalProgressAtMs >= mediaOfferAnswerTimeoutMs;
        if (!staleOffer) {
          this.scheduleMediaWatchdog(peerId, entry);
          return entry;
        }
        try {
          await entry.connection.setLocalDescription({ type: "rollback" });
        } catch {
          this.scheduleMediaWatchdog(peerId, entry);
          return entry;
        }
      }

      if (this.localAudioSourcePeerId === this.localPeerId) {
        await this.syncLocalAudioToPeer(peerId, entry, false);
      }
      try {
        entry.connection.restartIce?.();
      } catch {
        // createOffer({ iceRestart: true }) remains the interoperable fallback.
      }
      try {
        await this.signaling.createAndSendOffer(
          peerId,
          entry.connection,
          { iceRestart: true },
          "media",
          entry.connectionGeneration
        );
      } catch {
        // Signaling state can change between the stable check and
        // setLocalDescription. Keep this peer and let the bounded watchdog
        // retry instead of turning the race into an unhandled rejection.
        this.scheduleMediaWatchdog(peerId, entry);
        return entry;
      }
      entry.mediaNegotiationPending = false;
      this.noteMediaOfferSent(peerId, entry);
      this.clearMediaSyncRetry(entry);
      return entry;
    };

    return options?.alreadyQueued
      ? restart()
      : enqueuePeerOperation(entry, restart);
  }

  destroy() {
    this.destroyed = true;
    if (this.topologyRetryTimerId !== null) {
      clearTimeout(this.topologyRetryTimerId);
      this.topologyRetryTimerId = null;
    }
    this.topologyRetryRequestVersion = null;
    const pendingTopologySync = this.pendingTopologySync;
    this.pendingTopologySync = null;
    for (const waiter of pendingTopologySync?.waiters ?? []) {
      waiter.resolve();
    }
    this.mediaPlaybackEnabled = false;
    this.peerConnections.clearExpected();
    this.expectedRemotePeerIds.clear();
    this.pendingIncomingAdmissionKeys.clear();
    this.localAudioStream = null;
    this.localAudioSourcePeerId = null;
    this.localAudioMaxBitrateKbps = null;
    this.localPlaybackMediaEpoch = null;
    this.localMediaTrafficExpected = false;
    for (const [peerId, entry] of this.peerConnections.allEntries()) {
      this.releasePeer(peerId, entry);
    }
    this.peerConnections.clearPeers();
  }

  schedulePeerWatchdog(peerId: string, entry: PeerEntry) {
    this.healthMonitor.schedulePeerWatchdog(peerId, entry);
  }

  schedulePeerReconnect(peerId: string, entry: PeerEntry) {
    this.healthMonitor.schedulePeerReconnect(peerId, entry);
  }

  private async ensurePeer(
    peerId: string,
    shouldInitiate: boolean,
    linkKind: PeerLinkKind = "data",
    allowEmptyMediaOffer = false
  ) {
    const existing = this.peerConnections.get(peerId, linkKind);

    if (existing) {
      const existingAction = resolveExistingPeerConnectionAction({
        entry: existing
      });
      if (existingAction === "release") {
        this.releasePeer(peerId, existing);
      } else {
        if (shouldInitiate && existing.initiatorPeerId === this.localPeerId) {
          return existing;
        }
        return existing;
      }
    }

    const connection = new RTCPeerConnection(
      buildPeerConnectionConfig({
        peerId,
        iceServers: this.iceServers,
        resolveConnectionConfig: this.resolveConnectionConfig
      })
    );
    const entry = createPeerEntry({
      connection,
      initiatorPeerId: shouldInitiate ? this.localPeerId : null,
      nowMs: Date.now(),
      connectionGeneration: ++this.connectionGenerationSequence,
      linkKind
    });
    if (linkKind === "media" && typeof connection.addTransceiver === "function") {
      const transceiver = connection.addTransceiver("audio", {
        // Media has one authoritative sender. A listener-created sendrecv
        // m-line can race the source's first offer and leave both peers in
        // have-local-offer without a stable receiver track.
        direction: this.resolveLocalMediaDirection()
      });
      entry.audioTransceiver = transceiver;
      entry.audioSender = transceiver.sender;
      this.preferOpus(transceiver);
    }
    this.statsSampler.start(peerId, entry);

    let registered = false;

    bindPeerConnectionEvents({
      peerId,
      entry,
      localPeerId: this.localPeerId,
      connection,
      autoReconnect: this.autoReconnect,
      isCurrentEntry: (currentPeerId, currentEntry) =>
        this.peerConnections.get(currentPeerId, linkKind) === currentEntry,
      isExpectedPeer: (currentPeerId) => linkKind === "data"
        ? this.peerConnections.expects(currentPeerId) ||
          this.hasProvisionalIncomingAdmission(entry)
        : this.expectedMediaPeerIds().has(currentPeerId) ||
          this.hasProvisionalIncomingAdmission(entry),
      sendCandidate: (candidatePeerId, payload) =>
        this.signaling.send(
          candidatePeerId,
          "candidate",
          payload,
          linkKind,
          entry.connectionGeneration
        ),
      onPeerConnectionChange: (payload) => {
        this.onPeerConnectionChange?.(payload);
        if (payload.state === "connected") {
          if (linkKind === "media") {
            this.clearMediaDisconnectRecovery(payload.peerId);
            this.clearMediaWatchdog(entry);
            const latestSample = this.latestMediaSamples.get(payload.peerId);
            const hasOperationalMedia =
              (latestSample?.mediaReceiveBitrateKbps ?? 0) > 0 ||
              (latestSample?.mediaSendBitrateKbps ?? 0) > 0;
            if (hasOperationalMedia) {
              this.markMediaRecovered(payload.peerId);
            }
            void this.enqueueMediaOperation(payload.peerId, entry);
            if (this.hasExpectedRemoteAudioTrack(payload.peerId)) {
              this.scheduleMediaWatchdog(payload.peerId, entry);
            }
          }
        } else if (
          linkKind === "media" &&
          (payload.state === "failed" || payload.state === "closed") &&
          !entry.releasing
        ) {
          this.triggerMediaRecovery(payload.peerId, "connection-failed");
        } else if (linkKind === "media" && payload.state === "disconnected" && !entry.releasing) {
          this.scheduleMediaDisconnectRecovery(payload.peerId, entry);
        }
        if (
          linkKind === "media" &&
          payload.state !== "connected" &&
          !entry.releasing
        ) {
          this.scheduleMediaWatchdog(payload.peerId, entry);
        }
      },
      onIceConnectionStateChange: (payload) => {
        this.onIceConnectionStateChange?.(payload);
        if (linkKind !== "media" || entry.releasing) {
          return;
        }

        if (payload.state === "connected" || payload.state === "completed") {
          this.clearMediaDisconnectRecovery(payload.peerId);
          return;
        }
        if (payload.state === "disconnected") {
          // ICE can briefly lose its selected pair while the RTCPeerConnection
          // still reports `connected`. Use the same delayed recovery path as
          // connectionstatechange so this does not race the jitter buffer.
          this.scheduleMediaDisconnectRecovery(payload.peerId, entry);
          return;
        }
        if (payload.state === "failed" || payload.state === "closed") {
          this.triggerMediaRecovery(payload.peerId, "connection-failed");
        }
      },
      onPeerStalled: this.onPeerStalled,
      schedulePeerReconnect: (currentPeerId, currentEntry) =>
        this.schedulePeerReconnect(currentPeerId, currentEntry),
      schedulePeerWatchdog: (currentPeerId, currentEntry) =>
        this.schedulePeerWatchdog(currentPeerId, currentEntry),
      releasePeer: (currentPeerId, currentEntry) =>
        this.releasePeer(currentPeerId, currentEntry),
      bindChannel: (currentPeerId, currentEntry, channel) =>
        this.bindChannelCallback(currentPeerId, currentEntry, channel),
      onRemoteAudioTrack: this.onRemoteAudioTrack,
      onMediaStateChange: (payload) => {
        this.onMediaStateChange?.(payload);
        if (
          linkKind === "media" &&
          payload.direction === "receiver" &&
          payload.state === "live"
        ) {
          this.clearMediaWatchdog(entry);
          if (entry.receiverRtpActive) {
            this.markMediaRecovered(payload.peerId);
          }
        }
        if (
          linkKind === "media" &&
          payload.direction === "receiver" &&
          payload.state === "ended" &&
          !entry.releasing
        ) {
          this.triggerMediaRecovery(payload.peerId, "no-packets");
        }
      },
      onMediaTrackMuted: this.onMediaTrackMuted
    });

    this.peerConnections.set(peerId, entry, linkKind);
    registered = true;
    if (linkKind === "data") {
      this.schedulePeerWatchdog(peerId, entry);
    } else {
      this.scheduleMediaWatchdog(peerId, entry);
    }
    try {
      if (shouldInitiate && linkKind === "data") {
        const controlChannel = connection.createDataChannel("soqaro-control", {
          ordered: true
        });
        entry.channel = controlChannel;
        this.bindChannelCallback(peerId, entry, controlChannel);
        await enqueuePeerOperation(entry, async () => {
          await this.signaling.createAndSendOffer(
            peerId,
            connection,
            undefined,
            "data",
            entry.connectionGeneration
          );
          entry.lastSignalProgressAtMs = Date.now();
        });
      } else if (
        linkKind === "media" &&
        (shouldInitiate ||
          (this.localAudioSourcePeerId === this.localPeerId && this.hasLiveLocalAudioTrack()))
      ) {
        await enqueuePeerOperation(entry, async () => {
          await this.syncLocalAudioToPeer(peerId, entry, false);
          // Do not negotiate an empty media m-line during topology sync. A
          // listener-created recvonly offer with no source track races with
          // the real source offer when playback starts, leaving both peers in
          // have-local-offer and the listener without an ontrack event. The
          // source-side sync below will create the first offer once a live
          // track is attached; recovery offers remain available for an
          // already-established peer.
          if (!allowEmptyMediaOffer && !entry.audioSender?.track) {
            return;
          }
          try {
            await this.signaling.createAndSendOffer(
              peerId,
              connection,
              undefined,
              "media",
              entry.connectionGeneration
            );
            entry.mediaNegotiationPending = false;
            this.noteMediaOfferSent(peerId, entry);
            this.clearMediaSyncRetry(entry);
          } catch {
            this.scheduleMediaSyncRetry(peerId, entry);
          }
        });
      }

      return entry;
    } catch (error) {
      if (registered) {
        if (this.peerConnections.get(peerId, linkKind) === entry) {
          this.releasePeer(peerId, entry);
        }
      } else if (!entry.releasing) {
        // The entry never made it into the registry (construction failed
        // before set), so the registration guard would skip releasePeer and
        // leak the RTCPeerConnection. Tear it down directly.
        this.releasePeer(peerId, entry);
      }
      throw error;
    }
  }

  private releasePeer(peerId: string, entry: PeerEntry) {
    this.clearProvisionalIncomingAdmission(entry);
    if (entry.linkKind === "media") {
      // Closing a media PC does not reliably deliver a useful connection-state
      // event because the entry is removed before the browser emits its final
      // callback. Notify the room runtime explicitly so a source switch or a
      // failed replacement cannot leave a stale "playing" member behind.
      if (!this.destroyed) {
        this.onMediaStateChange?.({
          peerId,
          entry,
          direction: entry.senderTrackState !== "none" ? "sender" : "receiver",
          state: "none"
        });
      }
      this.latestMediaSamples.delete(peerId);
      this.clearMediaDisconnectRecovery(peerId);
      // Keep recovery history while an expected media peer is being replaced.
      // Otherwise every failed recreation starts at attempt zero and the
      // listener can loop forever without reaching a stable retry path.
      if (!this.expectedMediaPeerIds().has(peerId)) {
        this.mediaRecovery.delete(peerId);
      }
    }
    releasePeerConnectionEntry({
      peerId,
      entry,
      deleteIfCurrent: (currentPeerId, currentEntry) =>
        this.peerConnections.deleteIfCurrent(currentPeerId, currentEntry),
      clearPendingRequestsForPeer: this.clearPendingRequestsForPeerCallback,
      stopStatsSampling: (currentEntry) => this.statsSampler.stop(currentEntry),
      onDataBufferedAmountChange: this.onDataBufferedAmountChange
    });
    // Supervisor state is only dropped when the peer has left the admitted
    // topology; a recovery recreation keeps its state so budgets and counters
    // survive the rebuild.
    if (
      entry.linkKind === "media"
        ? !this.expectedMediaPeerIds().has(peerId)
        : !this.peerConnections.expects(peerId)
    ) {
      this.onPeerReleased?.(peerId, entry.linkKind);
    }
  }

  private shouldRestartPeerEntry(entry: PeerEntry) {
    return shouldRestartPeer({
      entry,
      nowMs: Date.now(),
      dataOpenTimeoutMs: 8_000,
      dataConnectingTimeoutMs: 12_000,
      connectionProgressTimeoutMs: 15_000
    });
  }

  private resolveLocalMediaDirection(): RTCRtpTransceiverDirection {
    return this.localAudioSourcePeerId === this.localPeerId
      ? "sendonly"
      : "recvonly";
  }

  private resolveLocalAudioBitrateKbps() {
    if (
      this.localAudioSourcePeerId !== this.localPeerId ||
      !this.hasLiveLocalAudioTrack()
    ) {
      return null;
    }
    return resolveFanoutAudioBitrateKbps({
      fanout: this.expectedRemotePeerIds.size,
      requestedKbps: this.localAudioMaxBitrateKbps
    });
  }

  private resolveAudioSenderBitrateKbps() {
    return this.resolveLocalAudioBitrateKbps();
  }

  private syncMediaTransceiverDirection(entry: PeerEntry) {
    const transceiver = entry.audioTransceiver;
    if (!transceiver || transceiver.direction === this.resolveLocalMediaDirection()) {
      return;
    }

    try {
      transceiver.direction = this.resolveLocalMediaDirection();
      entry.mediaNegotiationPending = true;
    } catch {
      // Older WebRTC implementations may expose direction as read-only.
      // The sender/receiver track path remains usable in that case.
    }
  }

  private async syncLocalAudioToPeer(
    peerId: string,
    entry: PeerEntry,
    renegotiate = true
  ) {
    if (entry.releasing) {
      return;
    }

    this.syncMediaTransceiverDirection(entry);

    const desiredTrack =
      this.localAudioSourcePeerId === this.localPeerId
        ? this.localAudioStream?.getAudioTracks().find((track) => track.readyState === "live") ?? null
        : null;
    const currentTrack = entry.audioSender?.track ?? null;
    if (!desiredTrack && !entry.audioSender) {
      entry.senderTrackState = "none";
      return;
    }

    if (desiredTrack && !entry.audioSender) {
      if (typeof entry.connection.addTrack !== "function") {
        entry.senderTrackState = "failed";
        return;
      }
      entry.audioSender = entry.connection.addTrack(
        desiredTrack,
        this.localAudioStream ?? new MediaStream([desiredTrack])
      );
      entry.senderStreamId = this.localAudioStream?.id ?? null;
      entry.senderTrackState = "live";
      entry.mediaNegotiationPending = true;
      await this.applyAudioSenderParameters(
        entry.audioSender,
        this.resolveAudioSenderBitrateKbps()
      );
      this.onMediaStateChange?.({
        peerId,
        entry,
        direction: "sender",
        state: "live"
      });
      if (renegotiate && entry.connection.signalingState === "stable") {
        await this.signaling.createAndSendOffer(
          peerId,
          entry.connection,
          undefined,
          "media",
          entry.connectionGeneration
        );
        this.noteMediaOfferSent(peerId, entry);
        entry.mediaNegotiationPending = false;
      }
      return;
    }

    if (!entry.audioSender) {
      return;
    }

    const desiredStream = desiredTrack ? this.localAudioStream : null;
    if (
      desiredStream &&
      entry.senderStreamId !== desiredStream.id &&
      typeof entry.audioSender.setStreams === "function"
    ) {
      try {
        // addTransceiver creates a sender without an associated MediaStream.
        // Keep the stream id on the sender so the next SDP carries a stable
        // msid and the remote peer can reliably fire ontrack after a late
        // source start or media-peer recovery.
        entry.audioSender.setStreams(desiredStream);
        entry.senderStreamId = desiredStream.id;
        entry.mediaNegotiationPending = true;
      } catch {
        // setStreams is optional in older WebRTC implementations. The RTP
        // sender remains usable through replaceTrack below.
      }
    } else if (!desiredTrack) {
      entry.senderStreamId = null;
    }

    if (currentTrack !== desiredTrack) {
      try {
        await entry.audioSender.replaceTrack(desiredTrack);
        entry.senderTrackState = desiredTrack ? "live" : "none";
        // A track attached after the initial source offer still needs a
        // media re-offer so the remote peer receives the track identity/MSID
        // and fires ontrack. replaceTrack alone can leave a connected but
        // permanently silent receiver when the first offer had no track.
        entry.mediaNegotiationPending = true;
        await this.applyAudioSenderParameters(
          entry.audioSender,
          this.resolveAudioSenderBitrateKbps()
        );
        this.onMediaStateChange?.({
          peerId,
          entry,
          direction: "sender",
          state: entry.senderTrackState
        });
      } catch {
        entry.senderTrackState = "failed";
        this.onMediaStateChange?.({
          peerId,
          entry,
          direction: "sender",
          state: "failed"
        });
        this.scheduleMediaSyncRetry(peerId, entry);
      }
    }

    const expectedConfiguredBitrateKbps = this.resolveAudioSenderBitrateKbps();
    if (
      entry.audioSender &&
      entry.configuredAudioMaxBitrateKbps !== expectedConfiguredBitrateKbps
    ) {
      await this.applyAudioSenderParameters(entry.audioSender, expectedConfiguredBitrateKbps);
      if (expectedConfiguredBitrateKbps === null) {
        entry.configuredAudioMaxBitrateKbps = null;
      }
    }

    if (
      entry.mediaNegotiationPending &&
      renegotiate &&
      entry.connection.signalingState === "stable"
    ) {
      try {
        await this.signaling.createAndSendOffer(
          peerId,
          entry.connection,
          undefined,
          "media",
          entry.connectionGeneration
        );
        this.noteMediaOfferSent(peerId, entry);
        entry.mediaNegotiationPending = false;
        this.clearMediaSyncRetry(entry);
      } catch {
        this.scheduleMediaSyncRetry(peerId, entry);
      }
    } else if (entry.mediaNegotiationPending && renegotiate) {
      this.scheduleMediaSyncRetry(peerId, entry);
    }
  }

  private enqueueMediaOperation(peerId: string, entry: PeerEntry) {
    const operation = enqueuePeerOperation(entry, () => this.syncLocalAudioToPeer(peerId, entry));
    void operation.catch(() => {
      this.scheduleMediaSyncRetry(peerId, entry);
    });
    return operation;
  }

  private scheduleMediaSyncRetry(peerId: string, entry: PeerEntry) {
    if (
      entry.releasing ||
      this.peerConnections.get(peerId, "media") !== entry ||
      entry.mediaSyncRetryTimerId !== null
    ) {
      return;
    }

    const attempt = Math.min(entry.mediaSyncRetryAttempts + 1, 8);
    entry.mediaSyncRetryAttempts = attempt;
    const delayMs = Math.min(2_000, 100 * 2 ** (attempt - 1));
    entry.mediaSyncRetryTimerId = setTimeout(() => {
      entry.mediaSyncRetryTimerId = null;
      if (
        entry.releasing ||
        this.peerConnections.get(peerId, "media") !== entry
      ) {
        return;
      }
      void this.enqueueMediaOperation(peerId, entry);
    }, delayMs);
  }

  private clearMediaSyncRetry(entry: PeerEntry) {
    if (entry.mediaSyncRetryTimerId !== null) {
      clearTimeout(entry.mediaSyncRetryTimerId);
      entry.mediaSyncRetryTimerId = null;
    }
    entry.mediaSyncRetryAttempts = 0;
  }

  private applyReceiverJitterPolicy(entry: PeerEntry, sample: PeerConnectionStatsSample) {
    const receiver = entry.audioReceiver as (RTCRtpReceiver & {
      playoutDelayHint?: number;
      jitterBufferTarget?: number | null;
    }) | null;
    if (!receiver) {
      return;
    }

    const loss = sample.packetLossRate;
    const jitter = sample.jitterMs;
    const elevated =
      (typeof loss === "number" && loss >= mediaRecoveryHealthyLossThreshold) ||
      (typeof jitter === "number" && jitter >= mediaRecoveryHealthyJitterThreshold);
    const healthy =
      (typeof loss !== "number" || loss < receiverHealthyLossThreshold) &&
      (typeof jitter !== "number" || jitter < receiverHealthyJitterThreshold);
    const wasElevated = this.elevatedReceiverBufferEntries.has(entry);
    const shouldElevate = elevated || (wasElevated && !healthy);
    if (shouldElevate === wasElevated) {
      return;
    }

    const playoutDelaySeconds = shouldElevate
      ? receiverElevatedPlayoutDelaySeconds
      : receiverPlayoutDelaySeconds;
    const jitterBufferTargetMs = shouldElevate
      ? receiverElevatedJitterBufferTargetMs
      : receiverJitterBufferTargetMs;
    try {
      if (
        "playoutDelayHint" in receiver &&
        receiver.playoutDelayHint !== playoutDelaySeconds
      ) {
        receiver.playoutDelayHint = playoutDelaySeconds;
      }
      if (
        "jitterBufferTarget" in receiver &&
        receiver.jitterBufferTarget !== jitterBufferTargetMs
      ) {
        receiver.jitterBufferTarget = jitterBufferTargetMs;
      }
      if (shouldElevate) {
        this.elevatedReceiverBufferEntries.add(entry);
      } else {
        this.elevatedReceiverBufferEntries.delete(entry);
      }
    } catch {
      // Browser-specific receiver implementations may reject runtime updates.
    }
  }

  private async applyAudioSenderParameters(
    sender: RTCRtpSender,
    effectiveMaxBitrateKbps: number | null = this.localAudioMaxBitrateKbps
  ) {
    if (effectiveMaxBitrateKbps === null || typeof sender.getParameters !== "function") {
      for (const [, entry] of this.peerConnections.allEntries()) {
        if (entry.audioSender === sender) {
          entry.configuredAudioMaxBitrateKbps = effectiveMaxBitrateKbps;
          entry.appliedAudioBitrateKbps = null;
          break;
        }
      }
      return;
    }
    const targetBitrateKbps = normalizeAudioBitrateKbps(effectiveMaxBitrateKbps);
    if (targetBitrateKbps === null) {
      return;
    }
    try {
      const parameters = sender.getParameters();
      const encodings = parameters.encodings?.length
        ? parameters.encodings
        : [{} as RTCRtpEncodingParameters];
      parameters.encodings = encodings.map((encoding) => ({
        ...encoding,
        maxBitrate: Math.round(targetBitrateKbps * 1000),
        dtx: "disabled",
        // Keep the audio sender ahead of best-effort SCTP traffic when both
        // RTP and a manual original-file transfer share the same ICE path.
        priority: "high",
        networkPriority: "high"
      }));
      try {
        await sender.setParameters(parameters);
      } catch {
        // Older browsers reject the optional priority fields. Retry with the
        // required bitrate only so a codec update never disables the sender.
        parameters.encodings = encodings.map((encoding) => ({
          ...encoding,
          maxBitrate: Math.round(targetBitrateKbps * 1000)
        }));
        await sender.setParameters(parameters);
      }
      for (const [, entry] of this.peerConnections.allEntries()) {
        if (entry.audioSender === sender) {
          entry.configuredAudioMaxBitrateKbps = effectiveMaxBitrateKbps;
          entry.appliedAudioBitrateKbps = targetBitrateKbps;
          break;
        }
      }
    } catch {
      // Browser codecs may reject a runtime bitrate update; RTP remains usable.
    }
  }

  private async recreatePeerNow(
    peerId: string,
    entry: PeerEntry,
    options?: { forceInitiate?: boolean }
  ): Promise<PeerEntry | null> {
    if (
      entry.linkKind !== "data" ||
      !this.expectedRemotePeerIds.has(peerId) ||
      this.peerConnections.get(peerId, "data") !== entry
    ) {
      return this.peerConnections.get(peerId, "data");
    }
    const reconnectAttempts = entry.reconnectAttempts;
    this.releasePeer(peerId, entry);
    const nextEntry = await this.ensurePeer(
      peerId,
      options?.forceInitiate === true || this.shouldInitiatePeer(peerId)
    );
    nextEntry.reconnectAttempts = reconnectAttempts;
    return nextEntry;
  }

  /** Re-run media sender setup after an incoming SDP answer/offer is applied. */
  async notifyRemoteDescriptionApplied(
    peerId: string,
    entry: PeerEntry,
    remoteDescriptionType: "offer" | "answer"
  ) {
    if (entry.linkKind !== "media" || entry.releasing) {
      return;
    }
    if (remoteDescriptionType === "offer") {
      // An incoming offer is still being answered by the signaling operation.
      // Bind the local source before createAnswer. The media m-line is
      // directional, so the answer must include the source track when the
      // source is answering a listener recovery offer.
      await this.syncLocalAudioToPeer(peerId, entry, false);
      entry.mediaNegotiationPending = false;
      return;
    }
    void this.enqueueMediaOperation(peerId, entry);
  }

  private preferOpus(transceiver: RTCRtpTransceiver) {
    try {
      const capabilities = RTCRtpReceiver.getCapabilities?.("audio")?.codecs ?? [];
      const opus = capabilities.filter((codec) => /opus/i.test(codec.mimeType));
      if (opus.length > 0) {
        const lossResilientOpus = opus.map((codec) => ({
          ...codec,
          sdpFmtpLine: ensureOpusPacketLossRecovery(codec.sdpFmtpLine)
        }));
        try {
          transceiver.setCodecPreferences?.(lossResilientOpus);
        } catch {
          // Some browsers allow codec ordering but reject modified fmtp lines.
          // Keep the normal Opus preference as a compatible fallback.
          transceiver.setCodecPreferences?.(opus);
        }
      }
    } catch {
      // Codec preference APIs are optional; normal SDP negotiation still works.
    }
  }

  private observeMediaHealth(peerId: string, sample: PeerConnectionStatsSample) {
    const entry = this.peerConnections.get(peerId, "media");
    if (!entry || entry.releasing) {
      return;
    }
    const mediaObserved = entry.senderTrackState === "live" ||
      entry.receiverTrackState === "live" ||
      (sample.mediaReceiveBitrateKbps ?? 0) > 0 ||
      (sample.mediaSendBitrateKbps ?? 0) > 0;
    if (!mediaObserved) {
      return;
    }
    const state = this.mediaRecovery.get(peerId) ?? createMediaRecoveryState();
    const loss = sample.packetLossRate ?? 0;
    const jitter = sample.jitterMs ?? 0;
    this.applyReceiverJitterPolicy(entry, sample);
    // A null bitrate means that the browser did not provide a comparable
    // stats sample yet. Treating it as zero creates false recovery cycles,
    // especially for a source that joined as the non-initiating peer.
    const previousReceivePacketAtMs = state.lastMediaReceivePacketAtMs;
    const previousSendPacketAtMs = state.lastMediaSendPacketAtMs;
    const currentReceivePacketAtMs = sample.lastMediaReceivePacketAtMs ?? null;
    const currentSendPacketAtMs = sample.lastMediaSendPacketAtMs ?? null;
    const receivePacketTimestampAdvanced = currentReceivePacketAtMs !== null &&
      (previousReceivePacketAtMs === null || currentReceivePacketAtMs > previousReceivePacketAtMs);
    const sendPacketTimestampAdvanced = currentSendPacketAtMs !== null &&
      (previousSendPacketAtMs === null || currentSendPacketAtMs > previousSendPacketAtMs);
    if (
      currentReceivePacketAtMs !== null &&
      (previousReceivePacketAtMs === null || currentReceivePacketAtMs >= previousReceivePacketAtMs)
    ) {
      state.lastMediaReceivePacketAtMs = currentReceivePacketAtMs;
    }
    if (
      currentSendPacketAtMs !== null &&
      (previousSendPacketAtMs === null || currentSendPacketAtMs >= previousSendPacketAtMs)
    ) {
      state.lastMediaSendPacketAtMs = currentSendPacketAtMs;
    }
    // A zero bitrate can be a rounded or delayed stats window. Only count it
    // as a packet outage after the browser has supplied a stable packet
    // timestamp and that timestamp stops advancing.
    const receivePacketTimestampStalled = currentReceivePacketAtMs !== null &&
      previousReceivePacketAtMs !== null &&
      !receivePacketTimestampAdvanced;
    const sendPacketTimestampStalled = currentSendPacketAtMs !== null &&
      previousSendPacketAtMs !== null &&
      !sendPacketTimestampAdvanced;
    const positiveRtpStale = state.lastPositiveMediaAtMs !== null &&
      Date.now() - state.lastPositiveMediaAtMs >= mediaPositiveRtpFreshMs;
    const hasEstablishedPositiveRtp = state.lastPositiveMediaAtMs !== null;
    const noReceivePackets = entry.receiverTrackState === "live" &&
      sample.mediaReceiveBitrateKbps !== null &&
      sample.mediaReceiveBitrateKbps <= 0 &&
      hasEstablishedPositiveRtp &&
      (receivePacketTimestampStalled ||
        (currentReceivePacketAtMs === null && positiveRtpStale));
    const noSendPackets = entry.senderTrackState === "live" &&
      sample.mediaSendBitrateKbps !== null &&
      sample.mediaSendBitrateKbps <= 0 &&
      hasEstablishedPositiveRtp &&
      (sendPacketTimestampStalled ||
        (currentSendPacketAtMs === null && positiveRtpStale));
    const localSourceIsActive = this.localMediaTrafficExpected &&
      this.localAudioSourcePeerId === this.localPeerId &&
      !!this.localAudioStream?.getAudioTracks().some((track) => track.readyState === "live");
    const remoteSourceIsActive = this.localMediaTrafficExpected &&
      this.localAudioSourcePeerId === peerId;
    const mediaTrafficActive = localSourceIsActive || remoteSourceIsActive;
    const receivePacketOutage = remoteSourceIsActive && noReceivePackets;
    const sendPacketOutage = localSourceIsActive && noSendPackets;
    state.degradedWindows = mediaTrafficActive && (loss >= 3 || jitter >= 20)
      ? state.degradedWindows + 1
      : 0;
    state.noPacketWindows = receivePacketOutage
      ? state.noPacketWindows + 1
      : 0;
    state.noSendPacketWindows = sendPacketOutage
      ? state.noSendPacketWindows + 1
      : 0;
    const hasPositiveMediaWindow =
      (sample.mediaReceiveBitrateKbps ?? 0) > 0 ||
      (sample.mediaSendBitrateKbps ?? 0) > 0;
    const hasHealthyMediaWindow = hasPositiveMediaWindow &&
      loss < mediaRecoveryHealthyLossThreshold &&
      jitter < mediaRecoveryHealthyJitterThreshold;
    if (hasPositiveMediaWindow) {
      state.lastPositiveMediaAtMs = Date.now();
    }
    this.mediaRecovery.set(peerId, state);
    if ((sample.mediaReceiveBitrateKbps ?? 0) > 0) {
      const wasReceiverLive = entry.receiverTrackState === "live";
      const wasReceiverRtpActive = entry.receiverRtpActive;
      this.recoverRemoteAudioTrackFromReceiver(entry);
      const receiverTrack = entry.audioReceiver?.track ??
        entry.remoteAudioStream?.getAudioTracks()[0] ??
        null;
      if (
        receiverTrack?.kind === "audio" &&
        receiverTrack.readyState === "live"
      ) {
        if (entry.receiverMuteTimerId !== null) {
          clearTimeout(entry.receiverMuteTimerId);
          entry.receiverMuteTimerId = null;
        }
        entry.receiverTrackState = "live";
      }
      entry.receiverRtpActive = true;
      if ((!wasReceiverLive || !wasReceiverRtpActive) && entry.receiverTrackState === "live") {
        this.onMediaStateChange?.({
          peerId,
          entry,
          direction: "receiver",
          state: "live"
        });
      }
    } else if (receivePacketOutage && state.noPacketWindows >= 1) {
      entry.receiverRtpActive = false;
    }
    state.highLossWindows = mediaTrafficActive && loss >= 5
      ? state.highLossWindows + 1
      : 0;
    state.highJitterWindows = mediaTrafficActive && jitter >= 30
      ? state.highJitterWindows + 1
      : 0;
    if (hasHealthyMediaWindow) {
      this.markMediaRecovered(peerId);
    } else {
      state.positiveMediaWindows = 0;
      this.mediaRecovery.set(peerId, state);
    }
    if (sendPacketOutage && state.noSendPacketWindows === 1) {
      // Keep the source peer alive. A zero outbound sample can be a silent
      // audio window or a stats gap; refresh the sender binding without
      // tearing down the ICE/DTLS connection that is still carrying media.
      void this.enqueueMediaOperation(peerId, entry);
    }
    // Keep the configured RTP target stable. Transport statistics are emitted
    // for diagnostics and recovery, but must not make a playing room silently
    // change its audio quality from one stats window to the next.
    if (localSourceIsActive && entry.audioSender) {
      entry.adaptiveAudioMaxBitrateKbps = null;
      const stableBitrateKbps = this.resolveLocalAudioBitrateKbps();
      if (entry.appliedAudioBitrateKbps !== stableBitrateKbps) {
        void this.applyAudioSenderParameters(entry.audioSender, stableBitrateKbps);
      }
    } else if (entry.adaptiveAudioMaxBitrateKbps !== null) {
      // The local source is no longer sending to this peer; drop the override
      // so the next reconcile returns to the stable room target.
      entry.adaptiveAudioMaxBitrateKbps = null;
    }
    const reason = (
      (receivePacketOutage && state.noPacketWindows >= mediaNoReceiveRecoveryWindows) ||
      (sendPacketOutage && state.noSendPacketWindows >= mediaNoSendRecoveryWindows)
    )
      ? "no-packets" as const
      : state.highLossWindows >= 3
        ? "loss" as const
        : state.highJitterWindows >= 3
          ? "jitter" as const
          : state.degradedWindows >= 3
            ? "loss" as const
            : null;
    if (!reason) {
      this.mediaRecovery.set(peerId, state);
      return;
    }
    this.mediaRecovery.set(peerId, state);
    this.triggerMediaRecovery(peerId, reason);
  }

  private scheduleMediaDisconnectRecovery(peerId: string, entry: PeerEntry) {
    const state = this.mediaRecovery.get(peerId) ?? createMediaRecoveryState();
    if (state.disconnectedTimerId !== null) {
      return;
    }
    state.disconnectedSinceMs ??= Date.now();
    state.disconnectedTimerId = setTimeout(() => {
      state.disconnectedTimerId = null;
      if (this.peerConnections.get(peerId, "media") !== entry) {
        return;
      }
      if (
        !entry.releasing &&
        (entry.connection.connectionState === "disconnected" ||
          entry.connection.iceConnectionState === "disconnected")
      ) {
        // A live negotiated track with a fresh positive RTP sample means the
        // browser still has a media path to repair. Stats can outlive a
        // connection-state blip, so keep checking until positive RTP stops
        // arriving instead of starting an ICE offer immediately.
        const recoveryState = this.mediaRecovery.get(peerId) ?? state;
        const hasRecentPositiveRtp = recoveryState.lastPositiveMediaAtMs !== null &&
          Date.now() - recoveryState.lastPositiveMediaAtMs < 4_000;
        const disconnectedForMs = Date.now() -
          (recoveryState.disconnectedSinceMs ?? Date.now());
        const awaitingInitialStats = recoveryState.lastPositiveMediaAtMs === null &&
          disconnectedForMs < mediaDisconnectedWithoutStatsMaxWaitMs;
        if (
          (entry.senderTrackState === "live" || entry.receiverTrackState === "live") &&
          (hasRecentPositiveRtp || awaitingInitialStats)
        ) {
          this.mediaRecovery.set(peerId, recoveryState);
          this.scheduleMediaDisconnectRecovery(peerId, entry);
          return;
        }
        this.triggerMediaRecovery(
          peerId,
          entry.senderTrackState === "live" || entry.receiverTrackState === "live"
            ? "no-packets"
            : "connection-failed"
        );
        return;
      }
      const recoveryState = this.mediaRecovery.get(peerId) ?? state;
      recoveryState.disconnectedSinceMs = null;
      this.mediaRecovery.set(peerId, recoveryState);
    }, mediaDisconnectedRecoveryDelayMs);
    this.mediaRecovery.set(peerId, state);
  }

  private noteMediaOfferSent(peerId: string, entry: PeerEntry) {
    entry.lastSignalProgressAtMs = Date.now();
    // A connected ICE/DTLS transport can still be waiting for a source-change
    // SDP answer. Restart the timer from the offer itself so that state cannot
    // be mistaken for a healthy media link indefinitely.
    this.clearMediaWatchdog(entry);
    this.scheduleMediaWatchdog(peerId, entry);
  }

  private scheduleMediaWatchdog(peerId: string, entry: PeerEntry) {
    if (entry.linkKind !== "media" || entry.releasing || entry.mediaWatchdogTimerId !== null) {
      return;
    }

    const watchdogDelayMs = entry.connection.signalingState === "have-local-offer"
      ? mediaOfferAnswerTimeoutMs
      : entry.connection.connectionState === "connected" &&
          this.hasExpectedRemoteAudioTrack(peerId) &&
          (entry.connection.remoteDescription !== null || entry.connection.localDescription !== null)
        ? mediaTrackWatchdogGraceMs
        : 8_000;
    entry.mediaWatchdogTimerId = setTimeout(() => {
      entry.mediaWatchdogTimerId = null;
      if (
        entry.releasing ||
        this.peerConnections.get(peerId, "media") !== entry
      ) {
        return;
      }

      const waitingForRemoteTrack =
        entry.connection.connectionState === "connected" &&
        this.hasExpectedRemoteAudioTrack(peerId) &&
        entry.receiverTrackState !== "live";
      if (waitingForRemoteTrack) {
        if (
          entry.connection.remoteDescription === null &&
          entry.connection.localDescription === null
        ) {
          // The source owns the first offer. A listener-created recvonly
          // offer before any media description exists races that source offer
          // and can leave both peers cycling without an ontrack event.
          this.scheduleMediaWatchdog(peerId, entry);
          return;
        }
        const waitingForMs = Date.now() - entry.lastSignalProgressAtMs;
        if (
          entry.mediaMissingTrackRecoveryAttempted &&
          waitingForMs < mediaOfferAnswerTimeoutMs
        ) {
          this.scheduleMediaWatchdog(peerId, entry);
          return;
        }
        if (waitingForMs < mediaTrackWatchdogGraceMs) {
          this.scheduleMediaWatchdog(peerId, entry);
          return;
        }
        if (
          entry.connection.signalingState !== "stable" &&
          waitingForMs < mediaOfferAnswerTimeoutMs
        ) {
          // Let an in-flight answer finish before declaring negotiation lost.
          // The timer must be kept alive; otherwise have-local-offer can leave
          // the listener waiting forever when the answer is delayed.
          this.scheduleMediaWatchdog(peerId, entry);
          return;
        }

        // ICE can be connected while the media m-line/track negotiation was
        // lost. Re-offer the media peer so the receiver gets ontrack without
        // disturbing the already healthy data peer.
        this.triggerMediaRecovery(peerId, "no-packets");
        return;
      }

      if (
        entry.connection.connectionState === "connected" &&
        entry.connection.signalingState === "stable"
      ) {
        return;
      }

      if (
        (entry.connection.connectionState === "disconnected" ||
          entry.connection.iceConnectionState === "disconnected") &&
        (entry.senderTrackState === "live" || entry.receiverTrackState === "live")
      ) {
        // The disconnected timer and consecutive zero-RTP samples own this
        // recovery path. Do not let the media watchdog issue a second offer
        // against a connection that may still recover in place.
        this.scheduleMediaDisconnectRecovery(peerId, entry);
        return;
      }

      const now = Date.now();
      const staleForMs = now - entry.lastSignalProgressAtMs;
      const ageMs = now - entry.createdAtMs;
      if (staleForMs < mediaOfferAnswerTimeoutMs && ageMs < 15_000) {
        this.scheduleMediaWatchdog(peerId, entry);
        return;
      }

      // A lost offer/answer can leave a perfectly healthy data connection
      // with a media connection stuck in new/checking/have-local-offer. A
      // media-only offer retries that path without touching DataChannel.
      this.triggerMediaRecovery(peerId, "connection-failed");
    }, watchdogDelayMs);
  }

  private clearMediaWatchdog(entry: PeerEntry) {
    if (entry.mediaWatchdogTimerId === null) {
      return;
    }
    clearTimeout(entry.mediaWatchdogTimerId);
    entry.mediaWatchdogTimerId = null;
  }

  private clearMediaDisconnectRecovery(peerId: string) {
    const state = this.mediaRecovery.get(peerId);
    if (!state) {
      return;
    }
    if (state.disconnectedTimerId !== null) {
      clearTimeout(state.disconnectedTimerId);
      state.disconnectedTimerId = null;
    }
    state.disconnectedSinceMs = null;
    this.mediaRecovery.set(peerId, state);
  }

  private triggerMediaRecovery(
    peerId: string,
    reason: "loss" | "jitter" | "no-packets" | "connection-failed"
  ) {
    const entry = this.peerConnections.get(peerId, "media");
    if (!entry || entry.releasing) {
      return;
    }
    const state = this.mediaRecovery.get(peerId) ?? createMediaRecoveryState();
    const mediaTransportDisconnected = entry.connection.connectionState === "disconnected" ||
      entry.connection.iceConnectionState === "disconnected";
    const mediaTransportFailed = entry.connection.connectionState === "failed" ||
      entry.connection.connectionState === "closed" ||
      entry.connection.iceConnectionState === "failed" ||
      entry.connection.iceConnectionState === "closed";
    const now = Date.now();
    const hasRecentPositiveRtp = state.lastPositiveMediaAtMs !== null &&
      now - state.lastPositiveMediaAtMs < mediaPositiveRtpFreshMs;
    const liveMediaDuringIceRecovery = mediaTransportDisconnected &&
      entry.connection.signalingState === "stable" &&
      (entry.senderTrackState === "live" || entry.receiverTrackState === "live") &&
      reason !== "no-packets" &&
      hasRecentPositiveRtp;
    const connectedLiveMedia = entry.connection.connectionState === "connected" &&
      entry.connection.signalingState === "stable" &&
      !mediaTransportDisconnected &&
      !mediaTransportFailed &&
      (entry.senderTrackState === "live" || entry.receiverTrackState === "live") &&
      hasRecentPositiveRtp &&
      reason !== "no-packets";
    const sustainedQualityFailure =
      (reason === "loss" && state.highLossWindows >= mediaSustainedLossRecoveryWindows) ||
      (reason === "jitter" && state.highJitterWindows >= mediaSustainedJitterRecoveryWindows);
    if ((connectedLiveMedia || liveMediaDuringIceRecovery) && !sustainedQualityFailure) {
      // A connected PeerConnection with a live negotiated track is still the
      // least disruptive playback path while RTP is still arriving. A live
      // track alone is not enough: browsers can keep it live after the RTP
      // flow has stopped, which is the connected-but-silent failure mode.
      state.degradedWindows = 0;
      state.noPacketWindows = 0;
      state.noSendPacketWindows = 0;
      state.highLossWindows = 0;
      state.highJitterWindows = 0;
      this.mediaRecovery.set(peerId, state);
      return;
    }
    state.restartTimesMs = state.restartTimesMs.filter((timestamp) => now - timestamp < 30_000);
    const lastRecoveryAtMs = state.restartTimesMs[state.restartTimesMs.length - 1] ?? null;
    if (lastRecoveryAtMs !== null && now - lastRecoveryAtMs < mediaRecoveryCooldownMs) {
      this.mediaRecovery.set(peerId, state);
      this.scheduleMediaWatchdog(peerId, entry);
      return;
    }
    if (
      entry.connection.signalingState !== "stable" &&
      Date.now() - entry.lastSignalProgressAtMs < mediaOfferAnswerTimeoutMs
    ) {
      this.mediaRecovery.set(peerId, state);
      this.scheduleMediaWatchdog(peerId, entry);
      return;
    }
    state.restartTimesMs.push(now);
    state.degradedWindows = 0;
    state.noPacketWindows = 0;
    state.noSendPacketWindows = 0;
    state.highLossWindows = 0;
    state.highJitterWindows = 0;
    state.positiveMediaWindows = 0;
    const restartCount = state.restartTimesMs.length;
    const shouldReportFailure = restartCount >= 2 &&
      (state.failureReportedAtMs === null || now - state.failureReportedAtMs >= 30_000);
    if (shouldReportFailure) {
      state.failureReportedAtMs = now;
    }
    this.mediaRecovery.set(peerId, state);
    this.onMediaRecovery?.({
      peerId,
      reason: shouldReportFailure ? "connection-failed" : reason,
      restartCount
    });
    const transportClosed = entry.connection.connectionState === "closed" ||
      entry.connection.iceConnectionState === "closed" ||
      entry.connection.signalingState === "closed";
    const transportStillUnusable = entry.connection.connectionState !== "connected" ||
      entry.connection.iceConnectionState === "disconnected" ||
      entry.connection.iceConnectionState === "failed";
    const forceQualityRecreate = sustainedQualityFailure &&
      restartCount > mediaIceRestartAttemptsBeforeRecreate;
    const recoveryOperation = this.restartMediaPeer(peerId, {
      // ICE restart is the normal recovery operation. Recreate the media PC
      // only when it is already closed or repeated in-place recovery failed
      // (including a persistent lossy candidate pair); otherwise each retry
      // discards an otherwise reusable RTP session.
      forceRecreate: transportClosed ||
        (transportStillUnusable && restartCount > mediaIceRestartAttemptsBeforeRecreate) ||
        forceQualityRecreate,
      // A connected PeerConnection can still carry RTP while its selected
      // candidate pair is persistently lossy. In that case an in-place ICE
      // restart is the least disruptive way to force a fresh candidate pair.
      forceIceRestart: sustainedQualityFailure && !forceQualityRecreate
    });
    const continueRecovery = () => {
      if (this.destroyed || !this.expectedMediaPeerIds().has(peerId)) {
        return;
      }
      const currentEntry = this.peerConnections.get(peerId, "media");
      if (!currentEntry) {
        // A failed forced recreation leaves no PeerConnection to own a
        // watchdog. Reconcile from the authoritative member/source topology.
        this.scheduleTopologyRetry();
        return;
      }
      this.scheduleMediaWatchdog(peerId, currentEntry);
      if (
        currentEntry.connection.connectionState === "disconnected" ||
        currentEntry.connection.iceConnectionState === "disconnected"
      ) {
        this.scheduleMediaDisconnectRecovery(peerId, currentEntry);
      }
    };
    void recoveryOperation.then(continueRecovery, () => {
      this.scheduleTopologyRetry();
      continueRecovery();
    });
  }

  private markMediaRecovered(peerId: string) {
    const state = this.mediaRecovery.get(peerId);
    if (!state) {
      return;
    }
    // Do not clear recovery history merely because RTP still trickles in. The
    // caller has already classified this window as healthy, and the counters
    // below also protect connection-state callbacks that have no fresh stats.
    if (state.highLossWindows > 0 || state.highJitterWindows > 0) {
      state.positiveMediaWindows = 0;
      this.mediaRecovery.set(peerId, state);
      return;
    }
    state.positiveMediaWindows = Math.min(3, state.positiveMediaWindows + 1);
    if (state.positiveMediaWindows < 3) {
      this.mediaRecovery.set(peerId, state);
      return;
    }
    state.degradedWindows = 0;
    state.noPacketWindows = 0;
    state.noSendPacketWindows = 0;
    state.highLossWindows = 0;
    state.highJitterWindows = 0;
    state.restartTimesMs = [];
    state.failureReportedAtMs = null;
    this.mediaRecovery.set(peerId, state);
  }

  private hasExpectedRemoteAudioTrack(peerId: string) {
    return this.localAudioSourcePeerId !== null &&
      this.localAudioSourcePeerId !== this.localPeerId &&
      this.localAudioSourcePeerId === peerId;
  }

  private recoverRemoteAudioTrackFromReceiver(entry: PeerEntry) {
    if (entry.releasing) {
      return;
    }

    let receiver = entry.audioReceiver;
    if (
      !receiver?.track ||
      receiver.track.kind !== "audio" ||
      receiver.track.readyState !== "live"
    ) {
      try {
        const receivers = entry.connection.getReceivers?.() ?? [];
        receiver = receivers.find((candidate) =>
          candidate.track?.kind === "audio" && candidate.track.readyState === "live"
        ) ?? null;
      } catch {
        return;
      }
    }

    const track = receiver?.track;
    if (!receiver || !track || track.kind !== "audio" || track.readyState !== "live") {
      return;
    }

    const streamHasTrack = entry.remoteAudioStream?.getAudioTracks().some(
      (candidate) => candidate.id === track.id
    );
    if (entry.remoteAudioTrackId === track.id && streamHasTrack) {
      return;
    }

    // Chromium can expose the receiver track before delivering ontrack after
    // a renegotiation. Adopt it on the next runtime poll so a connected media
    // Peer cannot remain permanently silent just because that event was lost.
    try {
      entry.audioReceiver = receiver;
      if (!streamHasTrack) {
        entry.remoteAudioStream = new MediaStream([track]);
      }
      entry.remoteAudioTrackId = track.id;
      entry.receiverTrackState = "live";
      entry.receiverRtpActive = track.muted !== true;
      entry.mediaMissingTrackRecoveryAttempted = false;
      this.clearMediaWatchdog(entry);
    } catch {
      // MediaStream construction is unavailable only in non-browser test or
      // embedded environments; the normal ontrack path remains intact.
    }
  }

  private shouldInitiatePeer(peerId: string) {
    return shouldInitiatePeerConnection(this.localPeerId, peerId);
  }
}

function normalizeAudioBitrateKbps(value: number | null) {
  return resolveFixedAudioBitrateKbps({ requestedKbps: value });
}

function ensureOpusPacketLossRecovery(sdpFmtpLine: string | undefined) {
  const params = (sdpFmtpLine ?? "")
    .split(";")
    .map((param) => param.trim())
    .filter(Boolean)
    .filter((param) => !/^useinbandfec=/i.test(param));
  if (!params.some((param) => /^minptime=/i.test(param))) {
    params.push("minptime=10");
  }
  params.push("useinbandfec=1");
  return params.join(";");
}
