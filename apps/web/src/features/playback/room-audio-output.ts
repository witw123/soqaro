"use client";

import {
  roomAudioActivationManager,
  type PrimeRoomAudioOutputsResult,
  type RoomAudioElementPlayOptions,
  type RoomAudioElementPlayResult
} from "./room-audio-activation-manager";
import { EqualizerFilterNodeChain } from "./audio-equalizer";

type PrimeRoomAudioOutputInput = {
  localAudio?: HTMLAudioElement | null;
};

type ApplyRoomAudioVolumeInput = {
  localAudio?: HTMLAudioElement | null;
  volume: number;
  loudnessGainDb?: number;
};

type BindLocalAudioElementOptions = {
  broadcast?: boolean;
  loudnessGainDb?: number;
  volume?: number;
};

type LocalAudioElementGraph = {
  element: HTMLAudioElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  normalizationGain: GainNode;
  equalizerChain: EqualizerFilterNodeChain | null;
  localGain: GainNode;
  broadcastDestination: MediaStreamAudioDestinationNode | null;
};

export type BroadcastStreamListener = (stream: MediaStream | null) => void;

export class RoomAudioOutput {
  private broadcastDestination: MediaStreamAudioDestinationNode | null = null;
  private readonly broadcastStreamListeners = new Set<BroadcastStreamListener>();
  private localAudioElementGraph: LocalAudioElementGraph | null = null;
  private equalizerGains: [number, number, number, number, number] | null = null;
  private readonly localAudioElementSources = new WeakMap<
    HTMLAudioElement,
    { context: AudioContext; source: MediaElementAudioSourceNode }
  >();
  private readonly elementVolumes = new WeakMap<HTMLAudioElement, number>();
  private readonly elementLoudnessGains = new WeakMap<HTMLAudioElement, number>();

  async primeOutputs(input: PrimeRoomAudioOutputInput): Promise<PrimeRoomAudioOutputsResult> {
    return roomAudioActivationManager.activateOutputs(input);
  }

  async resumeSharedAudioContext() {
    return roomAudioActivationManager.resumeSharedAudioContext();
  }

  async playElement(
    element: HTMLAudioElement | null | undefined,
    options?: RoomAudioElementPlayOptions
  ): Promise<RoomAudioElementPlayResult> {
    return roomAudioActivationManager.playElement(element, options);
  }

  async restoreAfterBackground(input: ApplyRoomAudioVolumeInput) {
    const element = input.localAudio;
    const shouldResumeContext = Boolean(
      (element && this.hasLocalAudioElementSource(element)) || this.isActivated()
    );
    if (!shouldResumeContext) {
      this.applyVolume(input);
      return true;
    }

    const resumed = await roomAudioActivationManager.resumeSharedAudioContext();
    this.applyVolume(input);
    return resumed;
  }

  async fadeGraphVolume(targetVolume: number, durationMs = 400): Promise<void> {
    const graph = this.localAudioElementGraph;
    if (!graph) return;
    const safeVolume = normalizeOutputVolume(targetVolume);
    try {
      const now = graph.context.currentTime;
      const durationSec = Math.max(0.05, durationMs / 1000);
      graph.localGain.gain.cancelScheduledValues(now);
      graph.localGain.gain.setValueAtTime(graph.localGain.gain.value, now);
      if (typeof (graph.localGain.gain as unknown as { linearRampToValueAtTime?: unknown }).linearRampToValueAtTime === "function") {
        (graph.localGain.gain as unknown as { linearRampToValueAtTime: (v: number, t: number) => void }).linearRampToValueAtTime(safeVolume, now + durationSec);
      } else if (typeof graph.localGain.gain.setTargetAtTime === "function") {
        graph.localGain.gain.setTargetAtTime(safeVolume, now, durationSec / 3);
      } else {
        graph.localGain.gain.setValueAtTime(safeVolume, now);
      }
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    } catch {
      graph.localGain.gain.value = safeVolume;
    }
  }

  async fadeOutAudio(durationMs = 400): Promise<void> {
    return this.fadeGraphVolume(0, durationMs);
  }

  async fadeInAudio(targetVolume: number, durationMs = 400): Promise<void> {
    return this.fadeGraphVolume(targetVolume, durationMs);
  }

  setEqualizerGains(gains: [number, number, number, number, number] | null) {
    this.equalizerGains = gains ? [...gains] : null;
    if (this.localAudioElementGraph?.equalizerChain) {
      if (gains) {
        this.localAudioElementGraph.equalizerChain.applyGains(gains);
      } else {
        this.localAudioElementGraph.equalizerChain.applyGains([0, 0, 0, 0, 0]);
      }
    }
  }

  getEqualizerGains(): [number, number, number, number, number] | null {
    return this.equalizerGains ? [...this.equalizerGains] : null;
  }

  applyVolume(input: ApplyRoomAudioVolumeInput) {
    const safeVolume = normalizeOutputVolume(input.volume);
    const loudnessGain = typeof input.loudnessGainDb === "number"
      ? normalizeGainDb(input.loudnessGainDb)
      : input.localAudio
        ? this.elementLoudnessGains.get(input.localAudio) ?? 1
        : 1;
    if (input.localAudio) {
      const element = input.localAudio;
      const previousVolume = this.elementVolumes.get(element);
      const previousLoudnessGain = this.elementLoudnessGains.get(element);
      const volumeChanged = previousVolume !== safeVolume;
      const loudnessChanged = typeof input.loudnessGainDb === "number" &&
        previousLoudnessGain !== loudnessGain;
      this.elementVolumes.set(element, safeVolume);
      if (typeof input.loudnessGainDb === "number") {
        this.elementLoudnessGains.set(element, loudnessGain);
      }
      const localGraph = this.localAudioElementGraph?.element === element
        ? this.localAudioElementGraph
        : null;
      if (localGraph) {
        if (volumeChanged || localGraph.localGain.gain.value !== safeVolume) {
          this.setGraphVolume(localGraph, safeVolume);
        }
        if (loudnessChanged || (typeof input.loudnessGainDb === "number" && localGraph.normalizationGain.gain.value !== loudnessGain)) {
          this.setGraphLoudnessGain(localGraph, loudnessGain);
        }
        element.volume = 1;
        return;
      }
      element.volume = normalizeOutputVolume(safeVolume * loudnessGain);
    }
  }

  bindLocalAudioElement(
    element: HTMLAudioElement | null | undefined,
    options?: BindLocalAudioElementOptions
  ) {
    if (!element) {
      return null;
    }

    const context = this.getSharedAudioContext();
    if (
      !context ||
      typeof context.createMediaElementSource !== "function" ||
      typeof context.createGain !== "function"
    ) {
      return null;
    }

    const requestedVolume = options?.volume !== undefined
      ? normalizeOutputVolume(options.volume)
      : this.elementVolumes.get(element) ?? normalizeOutputVolume(element.volume);
    const previousRequestedVolume = this.elementVolumes.get(element);
    if (options?.volume !== undefined) {
      this.elementVolumes.set(element, requestedVolume);
    }
    const destination = options?.broadcast === false
      ? null
      : this.getBroadcastDestination(context);
    if (options?.broadcast !== false && !destination) {
      return null;
    }

    if (
      this.localAudioElementGraph?.element === element &&
      this.localAudioElementGraph.context === context &&
      this.localAudioElementGraph.broadcastDestination === destination
    ) {
      const previousLoudnessGain = this.elementLoudnessGains.get(element);
      const graphGain = typeof options?.loudnessGainDb === "number"
        ? normalizeGainDb(options.loudnessGainDb)
        : this.elementLoudnessGains.get(element) ?? 1;
      if (typeof options?.loudnessGainDb === "number") {
        this.elementLoudnessGains.set(element, graphGain);
      }
      if (
        typeof options?.loudnessGainDb === "number" &&
        previousLoudnessGain !== graphGain
      ) {
        this.setGraphLoudnessGain(this.localAudioElementGraph, graphGain);
      }
      if (options?.volume !== undefined && previousRequestedVolume !== requestedVolume) {
        this.setGraphVolume(this.localAudioElementGraph, requestedVolume);
      }
      return destination?.stream ?? null;
    }

    this.disposeLocalAudioElementGraph();
    try {
      const cachedSource = this.localAudioElementSources.get(element);
      const source = cachedSource?.context === context
        ? cachedSource.source
        : context.createMediaElementSource(element);
      this.localAudioElementSources.set(element, { context, source });
      source.disconnect();

      const normalizationGain = context.createGain();
      const graphGain = typeof options?.loudnessGainDb === "number"
        ? normalizeGainDb(options.loudnessGainDb)
        : this.elementLoudnessGains.get(element) ?? 1;
      normalizationGain.gain.value = graphGain;
      this.elementLoudnessGains.set(element, graphGain);
      const localGain = context.createGain();
      localGain.gain.value = requestedVolume;

      let equalizerChain: EqualizerFilterNodeChain | null = null;
      if (typeof context.createBiquadFilter === "function") {
        equalizerChain = new EqualizerFilterNodeChain(context);
        if (this.equalizerGains) {
          equalizerChain.applyGains(this.equalizerGains);
        }
      }

      source.connect(normalizationGain);
      if (equalizerChain?.inputNode && equalizerChain?.outputNode) {
        normalizationGain.connect(equalizerChain.inputNode);
        equalizerChain.outputNode.connect(localGain);
      } else {
        normalizationGain.connect(localGain);
      }
      localGain.connect(context.destination);
      if (destination) {
        source.connect(destination);
      }
      this.localAudioElementGraph = {
        element,
        context,
        source,
        normalizationGain,
        equalizerChain,
        localGain,
        broadcastDestination: destination
      };
      // Volume is controlled by localGain so the source member's volume does
      // not reduce the level sent to other room members.
      element.volume = 1;
      return destination?.stream ?? null;
    } catch {
      this.disposeLocalAudioElementGraph();
      return null;
    }
  }

  unbindLocalAudioElement(element?: HTMLAudioElement | null) {
    // Creating a MediaElementAudioSourceNode permanently routes this element
    // through Web Audio. Disconnecting the graph is cleanup only; callers
    // must reconnect a remembered element to an audible graph rather than
    // assuming its native speaker output can be restored.
    if (!element || this.localAudioElementGraph?.element === element) {
      this.disposeLocalAudioElementGraph();
    }
  }

  isActivated() {
    return roomAudioActivationManager.isActivated();
  }

  isAudioContextReady() {
    return roomAudioActivationManager.isAudioContextReady();
  }

  hasLocalAudioElementSource(element?: HTMLAudioElement | null) {
    return !!element && this.localAudioElementSources.has(element);
  }

  getSharedAudioContext() {
    return roomAudioActivationManager.getSharedAudioContext();
  }

  subscribeBroadcastStream(listener: BroadcastStreamListener) {
    this.broadcastStreamListeners.add(listener);
    return () => {
      this.broadcastStreamListeners.delete(listener);
    };
  }

  getBroadcastDestination(context = this.getSharedAudioContext()) {
    if (!context) {
      return null;
    }
    if (this.broadcastDestination && this.broadcastDestination.context === context) {
      const track = this.broadcastDestination.stream.getAudioTracks()[0];
      if (!track || track.readyState !== "ended") {
        return this.broadcastDestination;
      }
    }
    this.disposeLocalAudioElementGraph();
    if (typeof context.createMediaStreamDestination !== "function") {
      return null;
    }
    this.disposeBroadcastDestination();
    this.broadcastDestination = context.createMediaStreamDestination();
    this.notifyBroadcastStreamChanged();
    return this.broadcastDestination;
  }

  getBroadcastStream() {
    return this.broadcastDestination?.stream ?? null;
  }

  getBroadcastTrackId() {
    return this.broadcastDestination?.stream.getAudioTracks()[0]?.id ?? null;
  }

  releaseRoomAudioSession() {
    this.disposeLocalAudioElementGraph();
    this.disposeBroadcastDestination();
  }

  private disposeLocalAudioElementGraph() {
    const graph = this.localAudioElementGraph;
    if (!graph) {
      return;
    }
    try {
      graph.source.disconnect();
    } catch {
      // The source may already be disconnected during a context transition.
    }
    try {
      graph.localGain.disconnect();
    } catch {
      // The gain may already be disconnected during a context transition.
    }
    try {
      graph.normalizationGain.disconnect();
    } catch {
      // The gain may already be disconnected during a context transition.
    }
    if (graph.equalizerChain) {
      graph.equalizerChain.disconnect();
    }
    this.localAudioElementGraph = null;
  }

  private setGraphLoudnessGain(graph: LocalAudioElementGraph, gain: number) {
    try {
      const now = graph.context.currentTime;
      graph.normalizationGain.gain.cancelScheduledValues(now);
      graph.normalizationGain.gain.setValueAtTime(gain, now);
    } catch {
      graph.normalizationGain.gain.value = gain;
    }
  }

  private setGraphVolume(graph: LocalAudioElementGraph, volume: number) {
    try {
      const now = graph.context.currentTime;
      graph.localGain.gain.cancelScheduledValues(now);
      graph.localGain.gain.setValueAtTime(volume, now);
    } catch {
      graph.localGain.gain.value = volume;
    }
  }

  private disposeBroadcastDestination() {
    const hadDestination = this.broadcastDestination !== null;
    this.broadcastDestination?.disconnect();
    for (const track of this.broadcastDestination?.stream.getTracks() ?? []) {
      track.stop();
    }
    this.broadcastDestination = null;
    if (hadDestination) {
      this.notifyBroadcastStreamChanged();
    }
  }

  private notifyBroadcastStreamChanged() {
    const stream = this.broadcastDestination?.stream ?? null;
    for (const listener of this.broadcastStreamListeners) {
      try {
        listener(stream);
      } catch {
        // A subscriber must not break the audio graph lifecycle.
      }
    }
  }
}

export const roomAudioOutput = new RoomAudioOutput();

function normalizeOutputVolume(value: number) {
  if (!Number.isFinite(value)) {
    return 0.72;
  }

  return Math.min(1, Math.max(0, value));
}

function normalizeGainDb(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(4, Math.max(0.063, 10 ** (value / 20)));
}
