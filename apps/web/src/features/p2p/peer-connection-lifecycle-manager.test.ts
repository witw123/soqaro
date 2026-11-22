import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerSignalMessage } from "@soqaro/shared";
import { P2PMesh } from "./mesh";
import { SignalingTransport } from "./signaling-transport";
import { PeerConnectionLifecycleManager } from "./peer-connection-lifecycle-manager";
import type { PeerEntry } from "./peer-connection-registry";
import type { PeerConnectionStatsSample } from "./connection-stats";
import {
  createPeerConnectionSupervisorState,
  markMediaRecoveryAttempt,
  resolvePreferredIceTransportPolicy
} from "./connection-supervisor";

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = "closed";
    this.onclose?.();
  });
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  configuration: RTCConfiguration | undefined;
  connectionState: RTCPeerConnectionState = "connected";
  iceConnectionState: RTCIceConnectionState = "checking";
  signalingState: RTCSignalingState = "stable";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCLocalSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  restartIce = vi.fn();
  setConfiguration = vi.fn((configuration: RTCConfiguration) => {
    this.configuration = configuration;
  });
  channel = new FakeDataChannel();
  mediaSender: {
    track: MediaStreamTrack | null;
    replaceTrack: ReturnType<typeof vi.fn>;
    setStreams: ReturnType<typeof vi.fn>;
  } | null = null;
  mediaTransceiver: {
    sender: NonNullable<FakeRTCPeerConnection["mediaSender"]>;
    direction: RTCRtpTransceiverDirection;
    setCodecPreferences: ReturnType<typeof vi.fn>;
  } | null = null;

  constructor(configuration?: RTCConfiguration) {
    this.configuration = configuration;
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }

  addTransceiver(
    _kind: string,
    options?: { direction?: RTCRtpTransceiverDirection }
  ) {
    this.mediaSender = {
      track: null,
      replaceTrack: vi.fn(async (track: MediaStreamTrack | null) => {
        this.mediaSender!.track = track;
      }),
      setStreams: vi.fn()
    };
    this.mediaTransceiver = {
      sender: this.mediaSender,
      direction: options?.direction ?? "sendrecv",
      setCodecPreferences: vi.fn()
    };
    return this.mediaTransceiver as unknown as RTCRtpTransceiver;
  }

  async createOffer(options?: RTCOfferOptions) {
    this.signalingState = "have-local-offer";
    return {
      type: "offer" as const,
      sdp: options?.iceRestart ? "fake-restart-offer" : "fake-offer"
    };
  }

  async createAnswer() {
    return {
      type: "answer" as const,
      sdp: "fake-answer"
    };
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type === "offer") {
      this.signalingState = "have-remote-offer";
      if (this.mediaTransceiver?.direction === "recvonly") {
        const track = {
          kind: "audio",
          id: "negotiated-remote-track",
          readyState: "live",
          muted: false
        } as unknown as MediaStreamTrack;
        this.ontrack?.({
          track,
          streams: [],
          receiver: null
        } as unknown as RTCTrackEvent);
      }
    } else if (description.type === "answer") {
      this.signalingState = "stable";
    }
  }

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
    this.localDescription = description ?? null;
    if (description?.type === "rollback") {
      this.signalingState = "stable";
    } else if (description?.type === "answer") {
      this.signalingState = "stable";
    }
  }

  close() {
    this.connectionState = "closed";
  }
}

function createManager(input: {
  localPeerId?: string;
  sendSignal?: (payload: unknown) => void;
  bindChannel?: (peerId: string, entry: PeerEntry, channel: RTCDataChannel) => void;
  clearPendingRequestsForPeer?: (peerId: string) => void;
  resolveConnectionConfig?: (peerId: string) => Partial<RTCConfiguration> | null | undefined;
  onMediaRecovery?: (payload: {
    peerId: string;
    reason: "loss" | "jitter" | "no-packets" | "connection-failed";
    restartCount: number;
  }) => void;
} = {}) {
  const sendSignal = input.sendSignal ?? vi.fn();
  const signaling = new SignalingTransport({
    roomId: "room_1",
    localPeerId: input.localPeerId ?? "peer_a",
    sendSignal: sendSignal as (payload: PeerSignalMessage) => void
  });
  return {
    manager: new PeerConnectionLifecycleManager({
      localPeerId: input.localPeerId ?? "peer_a",
      autoReconnect: true,
      iceServers: [],
      signaling,
      bindChannel: input.bindChannel ?? vi.fn(),
      clearPendingRequestsForPeer: input.clearPendingRequestsForPeer ?? vi.fn(),
      resolveConnectionConfig: input.resolveConnectionConfig,
      onMediaRecovery: input.onMediaRecovery
    }),
    sendSignal
  };
}

describe("PeerConnectionLifecycleManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    FakeRTCPeerConnection.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("syncs expected peers, initiates only lexically earlier peers, and binds data channels", async () => {
    const bindChannel = vi.fn();
    const { manager, sendSignal } = createManager({ bindChannel });

    await manager.syncPeers(["peer_b", "peer_a", ""]);

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(bindChannel).toHaveBeenCalledWith(
      "peer_b",
      expect.any(Object),
      FakeRTCPeerConnection.instances[0]!.channel
    );
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "offer",
        toPeerId: "peer_b",
        payload: {
          type: "offer",
          sdp: "fake-offer"
        }
      })
    );
    expect(manager.getConnectedPeerIds()).toEqual([]);
  });

  it("limits initial data negotiation and lets the newest topology supersede an in-flight sync", async () => {
    let releaseOffers!: () => void;
    const offerGate = new Promise<void>((resolve) => {
      releaseOffers = resolve;
    });
    vi.spyOn(FakeRTCPeerConnection.prototype, "createOffer")
      .mockImplementation(async function (this: FakeRTCPeerConnection) {
        await offerGate;
        this.signalingState = "have-local-offer";
        return {
          type: "offer" as const,
          sdp: "gated-offer"
        };
      });
    const { manager } = createManager();
    const staleSync = manager.syncPeers([
      "peer_b",
      "peer_c",
      "peer_d",
      "peer_e",
      "peer_f",
      "peer_g",
      "peer_h",
      "peer_i",
      "peer_j"
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(FakeRTCPeerConnection.instances).toHaveLength(3);

    const latestSync = manager.syncPeers(["peer_z"]);
    releaseOffers();
    await Promise.all([staleSync, latestSync]);

    expect(manager.getPeerEntry("peer_z", "data")).not.toBeNull();
    for (const peerId of ["peer_b", "peer_c", "peer_d"]) {
      expect(manager.getPeerEntry(peerId, "data")).toBeNull();
    }
    expect(FakeRTCPeerConnection.instances).toHaveLength(4);
  });

  it("does not prewarm listener media peers before an active source is known", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b", "peer_c"]);

    expect(manager.getPeerEntry("peer_b", "data")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "data")).not.toBeNull();
    expect(manager.getPeerEntry("peer_b", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).toBeNull();
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
  });

  it("negotiates Opus in-band FEC when the browser exposes codec fmtp preferences", async () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({
        codecs: [{
          mimeType: "audio/opus",
          sdpFmtpLine: "minptime=10;useinbandfec=0"
        }]
      })
    });
    const { manager } = createManager();
    const track = { id: "fec-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaTransceiver)!;
    expect(mediaPeer.mediaTransceiver?.setCodecPreferences).toHaveBeenCalledWith([
      expect.objectContaining({
        mimeType: "audio/opus",
        sdpFmtpLine: "minptime=10;useinbandfec=1"
      })
    ]);
  });

  it("keeps only the current source media peer on a listener", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b", "peer_c"]);
    manager.setLocalAudioStream(null, "peer_c");
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).not.toBeNull();
    expect(FakeRTCPeerConnection.instances.filter((entry) => entry.mediaSender?.track)).toHaveLength(0);
  });

  it("keeps one receiver media peer for a listener in a ten-member room", async () => {
    const { manager } = createManager();
    const remotePeerIds = Array.from({ length: 9 }, (_, index) =>
      `peer_${String.fromCharCode("b".charCodeAt(0) + index)}`
    );

    manager.setLocalAudioStream(null, "peer_b");
    await manager.syncPeers(remotePeerIds);

    expect(remotePeerIds.filter((peerId) => manager.getPeerEntry(peerId, "data"))).toHaveLength(9);
    expect(remotePeerIds.filter((peerId) => manager.getPeerEntry(peerId, "media"))).toEqual(["peer_b"]);
  });

  it("samples only the active listener media link", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b", "peer_c"]);
    manager.setLocalAudioStream(null, "peer_c");
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")?.statsIntervalId).not.toBeNull();

    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    manager.setLocalAudioStream(stream, "peer_a", 510);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")?.statsIntervalId).not.toBeNull();
  });

  it("releases listener media peers for local playback without dropping data peers", async () => {
    const { manager } = createManager();

    manager.setLocalAudioStream(null, "peer_b");
    await manager.syncPeers(["peer_b", "peer_c"]);
    expect(manager.getPeerEntry("peer_b", "media")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_b", "data")).not.toBeNull();

    await manager.setMediaPlaybackEnabled(false);

    expect(manager.getPeerEntry("peer_b", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_b", "data")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "data")).not.toBeNull();
    expect(manager.getPeerMediaState("peer_b")).toBeNull();

    await manager.setMediaPlaybackEnabled(true);

    expect(manager.getPeerEntry("peer_b", "media")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_b", "data")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "data")).not.toBeNull();
  });

  it("rejects delayed media signaling while local playback is enabled", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    await manager.setMediaPlaybackEnabled(false);

    await expect(
      manager.getOrCreateIncomingPeerEntry("peer_b", "media", "offer")
    ).resolves.toBeNull();
    expect(manager.getPeerEntry("peer_b", "data")).not.toBeNull();
  });

  it("fans out media from a local source while keeping one data link per member", async () => {
    const { manager } = createManager();
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a", 256);
    await manager.syncPeers(["peer_b", "peer_c", "peer_d"]);

    expect(FakeRTCPeerConnection.instances).toHaveLength(6);
    for (const peerId of ["peer_b", "peer_c", "peer_d"]) {
      expect(manager.getPeerEntry(peerId, "data")).not.toBeNull();
      expect(manager.getPeerEntry(peerId, "media")?.audioSender?.track).toBe(track);
    }
  });

  it("fans out the source track to all nine listeners without creating standby receiver links", async () => {
    const { manager } = createManager();
    const track = { id: "ten-member-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    const remotePeerIds = Array.from({ length: 9 }, (_, index) =>
      `peer_${String.fromCharCode("b".charCodeAt(0) + index)}`
    );

    manager.setLocalAudioStream(stream, "peer_a", 510);
    await manager.syncPeers(remotePeerIds);

    expect(remotePeerIds.filter((peerId) => manager.getPeerEntry(peerId, "data"))).toHaveLength(9);
    expect(remotePeerIds.filter((peerId) => manager.getPeerEntry(peerId, "media"))).toHaveLength(9);
    expect(remotePeerIds.filter((peerId) => manager.getPeerEntry(peerId, "media")?.audioSender?.track === track))
      .toHaveLength(9);
    expect(remotePeerIds.map((peerId) =>
      manager.getPeerEntry(peerId, "media")?.configuredAudioMaxBitrateKbps
    )).toEqual(Array.from({ length: 9 }, () => 320));
  });

  it("keeps source media fanout peers while the broadcast track is not live yet", async () => {
    const { manager, sendSignal } = createManager();

    manager.setLocalAudioStream(null, "peer_a");
    await manager.syncPeers(["peer_b", "peer_c"]);

    for (const peerId of ["peer_b", "peer_c"]) {
      expect(manager.getPeerEntry(peerId, "data")).not.toBeNull();
      expect(manager.getPeerEntry(peerId, "media")).not.toBeNull();
    }

    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    // No live track yet, so topology must reserve media peers without empty offers.
    expect(mediaOffers).toHaveLength(0);
  });

  it("does not recreate a connected listener media peer when the remote track is late", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaPeer.signalingState = "stable";
    mediaPeer.connectionState = "connected";
    mediaPeer.remoteDescription = { type: "offer", sdp: "source-offer" };
    // Expire the track-arrival grace window so recovery soft-reoffers instead
    // of waiting, while still keeping the existing PeerConnection.
    mediaEntry.lastSignalProgressAtMs = Date.now() - 4_000;

    await manager.restartMediaPeer("peer_b");

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaPeer.connectionState).toBe("connected");
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers.length).toBeGreaterThanOrEqual(1);
    expect(FakeRTCPeerConnection.instances.filter((entry) => entry.mediaSender)).toHaveLength(1);
  });

  it("restarts failed media ICE in place before replacing the peer", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = mediaEntry.connection as unknown as FakeRTCPeerConnection;
    mediaPeer.remoteDescription = { type: "offer", sdp: "source-offer" };
    mediaPeer.connectionState = "failed";
    mediaPeer.iceConnectionState = "failed";
    mediaPeer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaPeer.connectionState).toBe("failed");
    expect(mediaPeer.restartIce).toHaveBeenCalledTimes(1);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers.at(-1)?.payload).toEqual({
      type: "offer",
      sdp: "fake-restart-offer"
    });
  });

  it("replaces a media peer only after repeated in-place ICE restarts fail", async () => {
    let supervisorState = createPeerConnectionSupervisorState({
      roomId: "room_1",
      peerId: "peer_b"
    });
    const { manager } = createManager({
      resolveConnectionConfig: () => ({
        iceTransportPolicy: resolvePreferredIceTransportPolicy(supervisorState)
      }),
      onMediaRecovery: ({ restartCount, reason }) => {
        supervisorState = markMediaRecoveryAttempt({
          state: supervisorState,
          restartCount,
          reason
        });
      }
    });

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const initialEntry = manager.getPeerEntry("peer_b", "media")!;
    const initialPeer = initialEntry.connection as unknown as FakeRTCPeerConnection;
    initialPeer.remoteDescription = { type: "offer", sdp: "source-offer" };
    initialPeer.connectionState = "failed";
    initialPeer.iceConnectionState = "failed";
    initialPeer.onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(0);
    // Browsers usually leave failed after setLocalDescription and report the
    // ICE restart as connecting/checking while the remote answer is pending.
    initialPeer.connectionState = "connecting";
    initialPeer.iceConnectionState = "checking";

    await vi.advanceTimersByTimeAsync(24_100);

    expect(initialPeer.restartIce).toHaveBeenCalledTimes(2);
    expect(initialPeer.connectionState).toBe("closed");
    const replacementEntry = manager.getPeerEntry("peer_b", "media");
    expect(replacementEntry).not.toBe(initialEntry);
    expect(
      (replacementEntry?.connection as unknown as FakeRTCPeerConnection).configuration
        ?.iceTransportPolicy
    ).toBe("relay");
  });

  it("sends an explicit ICE restart offer when a source media peer stays disconnected", async () => {
    const { manager, sendSignal } = createManager();
    const track = { id: "source-recovery-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = mediaEntry.connection as unknown as FakeRTCPeerConnection;
    mediaPeer.signalingState = "stable";
    mediaPeer.remoteDescription = { type: "answer", sdp: "listener-answer" };
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: null,
      mediaSendBitrateKbps: 192,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample);
    const recoveryState = (manager as unknown as {
      mediaRecovery: Map<string, { lastPositiveMediaAtMs: number | null }>;
    }).mediaRecovery.get("peer_b")!;
    recoveryState.lastPositiveMediaAtMs = Date.now() - 5_000;
    (sendSignal as ReturnType<typeof vi.fn>).mockClear();

    mediaPeer.connectionState = "disconnected";
    mediaPeer.iceConnectionState = "disconnected";
    mediaPeer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaPeer.restartIce).toHaveBeenCalledTimes(1);
    expect(sendSignal).toHaveBeenCalledWith(expect.objectContaining({
      linkKind: "media",
      type: "offer",
      payload: {
        type: "offer",
        sdp: "fake-restart-offer"
      }
    }));
  });

  it("does not renegotiate a live media peer for a transient disconnected state", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    mediaPeer.connectionState = "disconnected";
    mediaPeer.onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaPeer.connectionState).toBe("disconnected");
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(0);
  });

  it("recovers a persistently disconnected live media peer when RTP stats are unavailable", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    mediaPeer.connectionState = "disconnected";
    mediaPeer.onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("recovers a disconnected live media peer after positive RTP stops", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 128,
      mediaSendBitrateKbps: null,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample);
    const recoveryState = (manager as unknown as {
      mediaRecovery: Map<string, { lastPositiveMediaAtMs: number | null }>;
    }).mediaRecovery.get("peer_b")!;
    recoveryState.lastPositiveMediaAtMs = Date.now() - 5_000;
    mediaPeer.connectionState = "disconnected";
    mediaPeer.onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("does not restart an ICE-disconnected media peer while RTP is still fresh", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);

    mediaPeer.iceConnectionState = "disconnected";
    mediaPeer.oniceconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(8_000);
    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 128,
      mediaSendBitrateKbps: null,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample);
    await vi.advanceTimersByTimeAsync(2_000);

    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaOffers).toHaveLength(0);
  });

  it("recovers an ICE-disconnected media peer after RTP stops", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 128,
      mediaSendBitrateKbps: null,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample);
    mediaPeer.iceConnectionState = "disconnected";
    mediaPeer.oniceconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("releases standby media peers when the source changes", async () => {
    const { manager } = createManager();
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a", 192);
    await manager.syncPeers(["peer_b", "peer_c"]);
    const oldPeer = manager.getPeerEntry("peer_c", "media")!;

    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).not.toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).toBeNull();
    expect(oldPeer.connection.connectionState).toBe("closed");
    expect(oldPeer.audioSender).toBeNull();
  });

  it("restarts ICE through the current peer entry without recreating it", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    const firstPeer = FakeRTCPeerConnection.instances[0]!;
    firstPeer.signalingState = "stable";

    await manager.restartIce("peer_b");

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(firstPeer.localDescription).toEqual({
      type: "offer",
      sdp: "fake-restart-offer"
    });
    expect(sendSignal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "offer",
        payload: {
          type: "offer",
          sdp: "fake-restart-offer"
        }
      })
    );
  });

  it("does not recreate a data peer after a queued topology removal", async () => {
    const { manager } = createManager();
    await manager.syncPeers(["peer_b"]);

    const removal = manager.syncPeers([]);
    const restart = manager.restartPeer("peer_b");
    await Promise.all([removal, restart]);

    expect(manager.getPeerEntry("peer_b", "data")).toBeNull();
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  });

  it("does not recreate a removed peer when delayed signaling arrives", async () => {
    const { manager } = createManager();
    await manager.syncPeers(["peer_b"]);

    await manager.syncPeers([]);
    const delayedDataEntry = await manager.getOrCreateIncomingPeerEntry("peer_b", "data");
    const delayedMediaEntry = await manager.getOrCreateIncomingPeerEntry("peer_b", "media");

    expect(delayedDataEntry).toBeNull();
    expect(delayedMediaEntry).toBeNull();
    expect(manager.getPeerEntry("peer_b", "data")).toBeNull();
    expect(manager.getPeerEntry("peer_b", "media")).toBeNull();
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  });

  it("does not admit a delayed media signal from a previous source", async () => {
    const { manager } = createManager();
    await manager.syncPeers(["peer_b", "peer_c"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getPeerEntry("peer_b", "media")).not.toBeNull();

    manager.setLocalAudioStream(null, "peer_c");
    const delayedMediaEntry = await manager.getOrCreateIncomingPeerEntry("peer_b", "media");

    expect(delayedMediaEntry).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getPeerEntry("peer_b", "media")).toBeNull();
    expect(manager.getPeerEntry("peer_c", "media")).not.toBeNull();
  });

  it("admits a source media offer before a late joiner knows the active source", async () => {
    const { manager } = createManager();
    const earlyMediaEntry = await manager.getOrCreateIncomingPeerEntry("peer_b", "media");

    expect(earlyMediaEntry).not.toBeNull();

    await manager.syncPeers(["peer_b"]);
    expect(manager.getPeerEntry("peer_b", "media")).toBe(earlyMediaEntry);

    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(earlyMediaEntry);
  });

  it("keeps an active source media offer while the member topology is still stale", async () => {
    const { manager } = createManager();

    // The late joiner has already reconciled an incomplete snapshot, while
    // playback state already points at the source peer.
    await manager.syncPeers([]);
    manager.setLocalAudioStream(null, "peer_source");

    const earlyMediaEntry = await manager.getOrCreateIncomingPeerEntry("peer_source", "media");

    expect(earlyMediaEntry).not.toBeNull();

    await manager.syncPeers(["peer_source"]);

    expect(manager.getPeerEntry("peer_source", "media")).toBe(earlyMediaEntry);
  });

  it("admits a media offer before the late joiner knows either the source or its peer", async () => {
    const { manager } = createManager();

    await manager.syncPeers([]);

    const earlyMediaEntry = await manager.getOrCreateIncomingPeerEntry(
      "peer_source",
      "media",
      "offer"
    );

    expect(earlyMediaEntry).not.toBeNull();
  });

  it("promotes an early media admission into the member topology", async () => {
    const { manager } = createManager();
    await manager.getOrCreateIncomingPeerEntry("peer_b", "media");
    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");

    await vi.advanceTimersByTimeAsync(8_000);

    expect(manager.getPeerEntry("peer_b", "media")).not.toBeNull();
  });

  it("clears pending request state and closes peers on destroy", async () => {
    const clearPendingRequestsForPeer = vi.fn();
    const { manager } = createManager({ clearPendingRequestsForPeer });

    await manager.syncPeers(["peer_b"]);
    const peer = FakeRTCPeerConnection.instances[0]!;

    manager.destroy();

    expect(clearPendingRequestsForPeer).toHaveBeenCalledWith("peer_b");
    expect(peer.connectionState).toBe("closed");
    expect(manager.getPeerEntry("peer_b")).toBeNull();
  });

  it("publishes an already-playing source track with one initial media offer", async () => {
    const { manager, sendSignal } = createManager();
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender);
    expect(mediaPeer?.mediaSender?.track).toBe(track);
    expect(
      (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((calls) => {
        const payload = calls[0] as PeerSignalMessage;
        return payload.linkKind === "media" && payload.type === "offer";
      }
      )
    ).toHaveLength(1);
  });

  it("publishes a member source track even when the remote peer initiates first", async () => {
    const { manager, sendSignal } = createManager({ localPeerId: "peer_b" });
    await manager.syncPeers(["peer_a"]);

    const track = { id: "member-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    manager.setLocalAudioStream(stream, "peer_b", 192);
    await vi.advanceTimersByTimeAsync(0);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender);
    expect(mediaPeer?.mediaSender?.track).toBe(track);
    expect(
      (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([value]) => {
        const payload = value as PeerSignalMessage;
        return payload.linkKind === "media" && payload.type === "offer";
      })
    ).toBe(true);
  });

  it("publishes an already-playing source track when the source is the non-initiating peer", async () => {
    const { manager, sendSignal } = createManager({ localPeerId: "peer_b" });
    const track = { id: "already-playing-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_b", 192);
    await manager.syncPeers(["peer_a"]);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender);
    expect(mediaPeer?.mediaSender?.track).toBe(track);
    expect(
      (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([value]) => {
        const payload = value as PeerSignalMessage;
        return payload.linkKind === "media" && payload.type === "offer";
      })
    ).toBe(true);
  });

  it("starts media negotiation from the source track instead of an empty listener offer", async () => {
    const { manager, sendSignal } = createManager();
    await manager.syncPeers(["peer_b"]);

    expect(FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)).toBeUndefined();

    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    manager.setLocalAudioStream(stream, "peer_a");
    await vi.advanceTimersByTimeAsync(0);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    expect(mediaPeer.mediaTransceiver?.direction).toBe("sendonly");
    mediaPeer.signalingState = "stable";

    expect(mediaPeer.mediaTransceiver?.direction).toBe("sendonly");
    expect(mediaPeer.mediaSender?.track).toBe(track);
    expect(mediaPeer.mediaSender?.setStreams).toHaveBeenCalledWith(stream);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("delivers a live track when a listener joins an already-playing source", async () => {
    vi.stubGlobal("MediaStream", class {
      constructor(private readonly tracks: MediaStreamTrack[] = []) {}

      getAudioTracks() {
        return this.tracks;
      }
    });
    let sourceMesh: P2PMesh | null = null;
    let listenerMesh: P2PMesh | null = null;
    const sourceSendSignal = vi.fn((payload: unknown) => {
      void listenerMesh?.handleSignal(payload as PeerSignalMessage);
    });
    const listenerSendSignal = vi.fn((payload: unknown) => {
      void sourceMesh?.handleSignal(payload as PeerSignalMessage);
    });
    sourceMesh = new P2PMesh("room_1", "peer_a", sourceSendSignal, {}, []);
    listenerMesh = new P2PMesh("room_1", "peer_b", listenerSendSignal, {}, []);

    const track = { id: "already-playing-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    listenerMesh.setLocalAudioStream(null, "peer_a");
    sourceMesh.setLocalAudioStream(stream, "peer_a");

    await sourceMesh.syncPeers(["peer_b"]);
    await listenerMesh.syncPeers(["peer_a"]);
    await vi.advanceTimersByTimeAsync(0);

    const listenerMediaPeer = FakeRTCPeerConnection.instances.find(
      (entry) => entry.mediaTransceiver?.direction === "recvonly"
    );
    expect(listenerMediaPeer?.mediaTransceiver?.direction).toBe("recvonly");
    expect(listenerMesh.getPeerMediaState("peer_a")?.receiverTrackState).toBe("live");
    const sentMediaOffers = sourceSendSignal.mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    const sentListenerMediaOffers = listenerSendSignal.mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(sentMediaOffers).toHaveLength(1);
    expect(sentListenerMediaOffers).toHaveLength(0);
    sourceMesh.destroy();
    listenerMesh.destroy();
  });

  it("does not create an empty media offer during topology sync", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(8_000);

    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(0);
  });

  it("uses recvonly for a listener and promotes the existing peer to sendonly", async () => {
    const { manager } = createManager();
    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    expect(mediaEntry.audioTransceiver?.direction).toBe("recvonly");

    const track = { id: "promoted-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    manager.setLocalAudioStream(stream, "peer_a");
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaEntry.audioTransceiver?.direction).toBe("sendonly");
    expect(mediaEntry.audioSender?.track).toBe(track);
  });

  it("binds the source track before answering an incoming media offer", async () => {
    const { manager } = createManager();
    await manager.syncPeers(["peer_b"]);
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    manager.setLocalAudioStream(stream, "peer_a");

    const entry = await manager.getOrCreatePeerEntry("peer_b", "media");
    await manager.notifyRemoteDescriptionApplied("peer_b", entry, "offer");

    expect(entry.audioTransceiver?.direction).toBe("sendonly");
    expect(entry.audioSender?.track).toBe(track);
    expect(entry.mediaNegotiationPending).toBe(false);
  });

  it("retries a transient local track binding failure without recreating the peer", async () => {
    const { manager } = createManager();
    await manager.syncPeers(["peer_b"]);

    const initialTrack = { id: "initial-source-track", readyState: "live" } as MediaStreamTrack;
    const initialStream = {
      getAudioTracks: () => [initialTrack]
    } as unknown as MediaStream;
    manager.setLocalAudioStream(initialStream, "peer_a");
    await vi.advanceTimersByTimeAsync(0);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaPeer.signalingState = "stable";
    mediaPeer.mediaSender!.replaceTrack.mockClear();
    mediaPeer.mediaSender!.replaceTrack.mockRejectedValueOnce(new Error("transient"));
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await vi.advanceTimersByTimeAsync(100);

    expect(mediaPeer.mediaSender!.replaceTrack).toHaveBeenCalledTimes(2);
    expect(mediaPeer.mediaSender!.track).toBe(track);
  });

  it("does not renegotiate when an already-bound source media connection becomes connected", async () => {
    const { manager, sendSignal } = createManager();
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaPeer.signalingState = "stable";
    mediaPeer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);

    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("does not restart a local source for unknown or zero outbound bitrate samples", async () => {
    const { manager, sendSignal } = createManager();
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    const sample = {
      mediaReceiveBitrateKbps: null,
      mediaSendBitrateKbps: null,
      packetLossRate: null,
      jitterMs: null
    } as PeerConnectionStatsSample;

    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", { ...sample, mediaSendBitrateKbps: 0 });
    observeMediaHealth("peer_b", { ...sample, mediaSendBitrateKbps: 0 });
    await vi.advanceTimersByTimeAsync(0);

    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaPeer.mediaSender?.track).toBe(track);
    expect(mediaEntry.senderTrackState).toBe("live");
    expect(mediaOffers).toHaveLength(1);
  });

  it("does not renegotiate a connected source media peer for a transient zero outbound window", async () => {
    const { manager } = createManager();
    const track = { id: "source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);

    const initialMediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    initialMediaPeer.signalingState = "stable";
    initialMediaPeer.remoteDescription = {
      type: "offer",
      sdp: "remote-offer"
    };
    await vi.advanceTimersByTimeAsync(0);
    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    const sample = {
      mediaReceiveBitrateKbps: null,
      mediaSendBitrateKbps: 0,
      lastMediaSendPacketAtMs: 100,
      packetLossRate: null,
      jitterMs: null
    } as PeerConnectionStatsSample;

    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    await vi.advanceTimersByTimeAsync(0);

    expect(initialMediaPeer.connectionState).toBe("connected");
    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(initialMediaPeer.mediaSender?.track).toBe(track);
    expect(initialMediaPeer.localDescription).toEqual({
      type: "offer",
      sdp: "fake-offer"
    });
    expect(FakeRTCPeerConnection.instances.filter((entry) => entry.mediaSender)).toHaveLength(1);
  });

  it("keeps the source media peer when pause and resume reuse the live broadcast track", async () => {
    const { manager, sendSignal } = createManager();
    const track = { id: "pause-resume-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = mediaEntry.connection as unknown as FakeRTCPeerConnection;
    mediaPeer.signalingState = "stable";

    // A paused HTMLAudioElement keeps the MediaStreamAudioDestination track
    // live; the source must therefore be idempotent across pause/resume ticks.
    manager.setLocalAudioStream(stream, "peer_a");
    await vi.advanceTimersByTimeAsync(0);
    manager.setLocalAudioStream(stream, "peer_a");
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaPeer.mediaSender?.track).toBe(track);
    expect(
      (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map(([payload]) => payload as PeerSignalMessage)
        .filter((payload) => payload.linkKind === "media" && payload.type === "offer")
    ).toHaveLength(1);
  });

  it("restarts a connected live media peer after sustained high loss", async () => {
    const { manager, sendSignal } = createManager();
    const track = { id: "stable-source-track", readyState: "live" } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track]
    } as unknown as MediaStream;

    manager.setLocalAudioStream(stream, "peer_a");
    await manager.syncPeers(["peer_b"]);

    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    mediaPeer.signalingState = "stable";
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    const degradedSample = {
      mediaReceiveBitrateKbps: null,
      mediaSendBitrateKbps: 192,
      packetLossRate: 8,
      jitterMs: 40
    } as PeerConnectionStatsSample;

    observeMediaHealth("peer_b", degradedSample);
    observeMediaHealth("peer_b", degradedSample);
    observeMediaHealth("peer_b", degradedSample);
    observeMediaHealth("peer_b", degradedSample);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(mediaPeer.connectionState).toBe("connected");
    expect(mediaPeer.restartIce).toHaveBeenCalledTimes(1);
    expect(
      (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map(([payload]) => payload as PeerSignalMessage)
        .filter((payload) => payload.linkKind === "media" && payload.type === "offer")
    ).toHaveLength(2);
  });

  it("expands the receiver jitter buffer during loss and restores it after healthy windows", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const receiver = {
      playoutDelayHint: 0.3,
      jitterBufferTarget: 300
    } as unknown as RTCRtpReceiver & {
      playoutDelayHint: number;
      jitterBufferTarget: number;
    };
    mediaEntry.audioReceiver = receiver;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);

    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 192,
      mediaSendBitrateKbps: null,
      packetLossRate: 6,
      jitterMs: 24
    } as PeerConnectionStatsSample);
    expect(receiver.playoutDelayHint).toBe(0.5);
    expect(receiver.jitterBufferTarget).toBe(500);

    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 192,
      mediaSendBitrateKbps: null,
      packetLossRate: 0,
      jitterMs: 4
    } as PeerConnectionStatsSample);
    expect(receiver.playoutDelayHint).toBe(0.3);
    expect(receiver.jitterBufferTarget).toBe(300);
  });

  it("does not reoffer a connected listener when its live receiver has a transient packet gap", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const initialMediaPeer = mediaEntry.connection as unknown as FakeRTCPeerConnection;
    initialMediaPeer.signalingState = "stable";
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    const sample = {
      mediaReceiveBitrateKbps: 0,
      mediaSendBitrateKbps: null,
      lastMediaReceivePacketAtMs: 100,
      packetLossRate: null,
      jitterMs: null
    } as PeerConnectionStatsSample;

    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    observeMediaHealth("peer_b", sample);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(initialMediaPeer.localDescription).toBeNull();
    expect(FakeRTCPeerConnection.instances.filter((entry) => entry.mediaSender)).toHaveLength(1);
  });

  it("recovers a connected live receiver after established RTP stops", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = mediaEntry.connection as unknown as FakeRTCPeerConnection;
    mediaPeer.signalingState = "stable";
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = true;
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);

    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 128,
      mediaSendBitrateKbps: null,
      lastMediaReceivePacketAtMs: 200,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample);
    const zeroSample = {
      mediaReceiveBitrateKbps: 0,
      mediaSendBitrateKbps: null,
      lastMediaReceivePacketAtMs: 200,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample;
    observeMediaHealth("peer_b", zeroSample);
    observeMediaHealth("peer_b", zeroSample);
    observeMediaHealth("peer_b", zeroSample);
    observeMediaHealth("peer_b", zeroSample);
    observeMediaHealth("peer_b", zeroSample);
    await vi.advanceTimersByTimeAsync(10);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(sendSignal).toHaveBeenCalledWith(expect.objectContaining({
      linkKind: "media",
      type: "offer"
    }));
  });

  it("actively reoffers a connected listener media peer when its remote track never arrives", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaPeer.signalingState = "stable";
    mediaPeer.connectionState = "connected";
    mediaPeer.remoteDescription = { type: "offer", sdp: "source-offer" };
    await vi.advanceTimersByTimeAsync(8_000);

    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    expect(FakeRTCPeerConnection.instances.filter((entry) => entry.mediaSender)).toHaveLength(1);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);

    await manager.restartMediaPeer("peer_b");
    const retryOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(retryOffers).toHaveLength(1);
  });

  it("actively reoffers after a connected listener loses receiver packets", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    const mediaEntry = manager.getPeerEntry("peer_b", "media")!;
    mediaPeer.signalingState = "stable";
    mediaEntry.receiverTrackState = "live";
    mediaEntry.receiverRtpActive = false;

    await vi.advanceTimersByTimeAsync(3_000);
    await manager.restartMediaPeer("peer_b");

    expect(mediaPeer.connectionState).toBe("connected");
    expect(manager.getPeerEntry("peer_b", "media")).toBe(mediaEntry);
    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("does not recover a deliberately silent stream while the room is paused", async () => {
    const onMediaRecovery = vi.fn();
    const { manager } = createManager({ onMediaRecovery });

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b", null, false);
    await vi.advanceTimersByTimeAsync(0);

    const entry = manager.getPeerEntry("peer_b", "media")!;
    entry.receiverTrackState = "live";
    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    const sample = {
      mediaReceiveBitrateKbps: 128,
      mediaSendBitrateKbps: null,
      lastMediaReceivePacketAtMs: 100,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample;

    observeMediaHealth("peer_b", sample);
    for (let index = 0; index < 4; index += 1) {
      observeMediaHealth("peer_b", {
        ...sample,
        mediaReceiveBitrateKbps: 0
      });
    }

    expect(onMediaRecovery).not.toHaveBeenCalled();
  });

  it("allows a forced media recovery to announce a replacement receiver peer", async () => {
    const { manager, sendSignal } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const mediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;
    mediaPeer.signalingState = "stable";
    await manager.restartMediaPeer("peer_b", { forceRecreate: true });

    const mediaOffers = (sendSignal as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([payload]) => payload as PeerSignalMessage)
      .filter((payload) => payload.linkKind === "media" && payload.type === "offer");
    expect(mediaOffers).toHaveLength(1);
  });

  it("serializes concurrent media recovery requests for one peer", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const initialMediaPeer = FakeRTCPeerConnection.instances.find((entry) => entry.mediaSender)!;

    const first = manager.restartMediaPeer("peer_b", { forceRecreate: true });
    const second = manager.restartMediaPeer("peer_b", { forceRecreate: true });
    await Promise.all([first, second]);

    expect(initialMediaPeer.connectionState).toBe("closed");
    expect(FakeRTCPeerConnection.instances.filter((entry) => entry.mediaSender)).toHaveLength(2);
  });

  it("restores a failed receiver state when RTP resumes", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);

    const entry = manager.getPeerEntry("peer_b", "media")!;
    const track = {
      kind: "audio",
      id: "resumed-track",
      readyState: "live"
    } as MediaStreamTrack;
    entry.audioReceiver = { track } as unknown as RTCRtpReceiver;
    entry.remoteAudioStream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    entry.remoteAudioTrackId = track.id;
    entry.receiverTrackState = "failed";
    entry.receiverRtpActive = false;

    const observeMediaHealth = (manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
    }).observeMediaHealth.bind(manager);
    observeMediaHealth("peer_b", {
      mediaReceiveBitrateKbps: 261,
      mediaSendBitrateKbps: null,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample);

    expect(entry.receiverTrackState).toBe("live");
    expect(entry.receiverRtpActive).toBe(true);
  });

  it("requires consecutive positive media windows before clearing recovery history", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    manager.getPeerEntry("peer_b", "media")!.receiverTrackState = "live";

    const internals = manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
      mediaRecovery: Map<string, { positiveMediaWindows: number }>;
    };
    const observeMediaHealth = internals.observeMediaHealth.bind(manager);
    const positiveSample = {
      mediaReceiveBitrateKbps: null,
      mediaSendBitrateKbps: 96,
      packetLossRate: 0,
      jitterMs: 2
    } as PeerConnectionStatsSample;
    const emptySample = {
      ...positiveSample,
      mediaSendBitrateKbps: 0
    };

    observeMediaHealth("peer_b", positiveSample);
    expect(internals.mediaRecovery.get("peer_b")?.positiveMediaWindows).toBe(1);
    observeMediaHealth("peer_b", emptySample);
    expect(internals.mediaRecovery.get("peer_b")?.positiveMediaWindows).toBe(0);
    observeMediaHealth("peer_b", positiveSample);
    observeMediaHealth("peer_b", positiveSample);
    expect(internals.mediaRecovery.get("peer_b")?.positiveMediaWindows).toBe(2);
  });

  it("does not clear recovery history while packet loss remains high", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const entry = manager.getPeerEntry("peer_b", "media")!;
    entry.receiverTrackState = "live";
    entry.receiverRtpActive = true;

    const internals = manager as unknown as {
      observeMediaHealth: (peerId: string, sample: PeerConnectionStatsSample) => void;
      mediaRecovery: Map<string, {
        highLossWindows: number;
        positiveMediaWindows: number;
      }>;
    };
    const observeMediaHealth = internals.observeMediaHealth.bind(manager);
    const degradedSample = {
      mediaReceiveBitrateKbps: 128,
      mediaSendBitrateKbps: null,
      packetLossRate: 8,
      jitterMs: 4
    } as PeerConnectionStatsSample;

    observeMediaHealth("peer_b", degradedSample);
    observeMediaHealth("peer_b", degradedSample);
    entry.connection.onconnectionstatechange?.(new Event("connectionstatechange"));

    expect(internals.mediaRecovery.get("peer_b")?.highLossWindows).toBeGreaterThan(0);
    expect(internals.mediaRecovery.get("peer_b")?.positiveMediaWindows).toBe(0);
  });

  it("does not let a stale media sample report receiver RTP as active", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const entry = manager.getPeerEntry("peer_b", "media")!;
    entry.receiverRtpActive = false;
    (manager as unknown as {
      latestMediaSamples: Map<string, PeerConnectionStatsSample>;
    }).latestMediaSamples.set("peer_b", {
      mediaReceiveBitrateKbps: 261
    } as PeerConnectionStatsSample);

    expect(manager.getPeerMediaState("peer_b")?.receiverRtpActive).toBe(false);
  });

  it("does not let receiver-track discovery mask a zero RTP window", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    manager.setLocalAudioStream(null, "peer_b");
    await vi.advanceTimersByTimeAsync(0);
    const entry = manager.getPeerEntry("peer_b", "media")!;
    const track = {
      kind: "audio",
      id: "known-track",
      readyState: "live",
      muted: false
    } as unknown as MediaStreamTrack;
    entry.audioReceiver = { track } as unknown as RTCRtpReceiver;
    entry.remoteAudioStream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    entry.remoteAudioTrackId = track.id;
    entry.receiverTrackState = "live";
    entry.receiverRtpActive = false;

    expect(manager.getPeerMediaState("peer_b")?.receiverRtpActive).toBe(false);
  });

  it("updates ICE servers in place without recreating active peer connections", async () => {
    const { manager } = createManager();

    await manager.syncPeers(["peer_b"]);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    const existingConnection = FakeRTCPeerConnection.instances[0]!;
    const closeSpy = vi.spyOn(existingConnection, "close");

    const refreshedServers = [
      {
        urls: "turn:turn.example.com:3478?transport=udp",
        username: "u-next",
        credential: "c-next"
      }
    ];
    manager.updateIceServers(refreshedServers);

    expect(closeSpy).not.toHaveBeenCalled();
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(existingConnection.setConfiguration).toHaveBeenCalledTimes(1);
    expect(existingConnection.configuration?.iceServers).toEqual(refreshedServers);

    await manager.syncPeers(["peer_b", "peer_c"]);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(FakeRTCPeerConnection.instances[1]?.configuration?.iceServers).toEqual(refreshedServers);
  });
});
