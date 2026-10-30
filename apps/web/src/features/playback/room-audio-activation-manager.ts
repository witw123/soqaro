"use client";

const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";

type PrimeAudioElementInput = {
  element: HTMLAudioElement | null | undefined;
};

export type RoomAudioElementPlayResult = {
  ok: boolean;
  error: string | null;
};

export type RoomAudioElementPlayOptions = {
  force?: boolean;
  /** Prevent an asynchronous play request from starting after its timeline was replaced. */
  isCurrent?: () => boolean;
  /** Refresh a local file's room position after context resume, before play. */
  beforePlay?: () => void;
  /** Remote MediaStream elements do not depend on the shared Web Audio graph. */
  resumeAudioContext?: boolean;
  /** Fail instead of reporting success when this element is routed through Web Audio but its context cannot run. */
  requireRunningAudioContext?: boolean;
  /** A muted autoplay retry is not an audible unlock on iPad Safari. */
  allowMutedFallback?: boolean;
};

export type PrimeRoomAudioOutputsResult = {
  ok: boolean;
  local: RoomAudioElementPlayResult;
};

export class RoomAudioActivationManager {
  private sharedContext: AudioContext | null = null;
  private activated = false;
  private lifecycleListenersInstalled = false;
  private resumeInFlight: Promise<boolean> | null = null;
  private readonly playedElementSourceKeys = new WeakMap<HTMLAudioElement, string>();
  private readonly playInFlight = new WeakMap<
    HTMLAudioElement,
    { sourceKey: string; promise: Promise<RoomAudioElementPlayResult> }
  >();
  private readonly sourceObjectIds = new WeakMap<object, number>();
  private nextSourceObjectId = 1;

  async activateOutputs(input: {
    localAudio?: HTMLAudioElement | null;
  }): Promise<PrimeRoomAudioOutputsResult> {
    const [contextReady, local] = await Promise.all([
      this.resumeSharedAudioContext().catch(() => false),
      this.primeAudioElement({ element: input.localAudio })
    ]);
    this.activated = contextReady || local.ok;
    if (local.ok && input.localAudio) {
      this.rememberElementSource(input.localAudio);
    }
    return {
      ok: this.activated,
      local
    };
  }

  async playElement(
    element: HTMLAudioElement | null | undefined,
    options: RoomAudioElementPlayOptions = {}
  ): Promise<RoomAudioElementPlayResult> {
    if (!element) {
      return {
        ok: false,
        error: "missing-audio-element"
      };
    }

    try {
      if (options.isCurrent?.() === false) {
        return {
          ok: false,
          error: "play-obsolete"
        };
      }
      let audioContextReady = true;
      if (options.resumeAudioContext !== false) {
        audioContextReady = await this.resumeSharedAudioContext();
      }
      if (options.requireRunningAudioContext && !audioContextReady) {
        return {
          ok: false,
          error: "audio-context-suspended"
        };
      }
      if (options.isCurrent?.() === false) {
        return {
          ok: false,
          error: "play-obsolete"
        };
      }
      const sourceKey = this.getElementSourceKey(element);
      const pendingPlay = this.playInFlight.get(element);
      if (pendingPlay?.sourceKey === sourceKey) {
        return pendingPlay.promise;
      }
      // If the same concrete media source is already playing, skip play() to
      // avoid a potential NotAllowedError when the user gesture that started
      // playback has expired.  When track switching replaces src/srcObject,
      // the element may still report paused=false from the previous source;
      // in that case we must call play() for the new source or the UI can
      // advance while the new song stays silent.
      if (
        !options.force &&
        !element.paused &&
        this.playedElementSourceKeys.get(element) === sourceKey
      ) {
        this.activated = true;
        return {
          ok: true,
          error: null
        };
      }
      if (options.isCurrent?.() === false) {
        return {
          ok: false,
          error: "play-obsolete"
        };
      }
      const promise = this.startElementPlayback(element, sourceKey, options);
      this.playInFlight.set(element, { sourceKey, promise });
      try {
        return await promise;
      } finally {
        if (this.playInFlight.get(element)?.promise === promise) {
          this.playInFlight.delete(element);
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "play-rejected"
      };
    }
  }

  private async startElementPlayback(
    element: HTMLAudioElement,
    sourceKey: string,
    options: RoomAudioElementPlayOptions
  ): Promise<RoomAudioElementPlayResult> {
    try {
      options.beforePlay?.();
      await element.play();
      this.activated = true;
      if (this.getElementSourceKey(element) === sourceKey) {
        this.playedElementSourceKeys.set(element, sourceKey);
      }
      return {
        ok: true,
        error: null
      };
    } catch (error) {
      if (!isAutoplayBlockedError(error)) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "play-rejected"
        };
      }

      if (options.allowMutedFallback === false) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "autoplay-blocked"
        };
      }

      const originalMuted = element.muted;
      const originalVolume = element.volume;
      try {
        if (options.isCurrent?.() === false) {
          return {
            ok: false,
            error: "play-obsolete"
          };
        }
        // Chromium permits muted autoplay even after the transient click token
        // has expired. Start the concrete local source muted, then restore
        // its audible state without replacing or reloading the element again.
        element.muted = true;
        options.beforePlay?.();
        await element.play();
        this.activated = true;
        this.playedElementSourceKeys.set(element, this.getElementSourceKey(element));
        return {
          ok: true,
          error: null
        };
      } catch (retryError) {
        return {
          ok: false,
          error: retryError instanceof Error ? retryError.message : "play-rejected"
        };
      } finally {
        element.muted = originalMuted;
        element.volume = originalVolume;
      }
    }
  }

  isActivated() {
    return this.activated;
  }

  isAudioContextReady() {
    return this.sharedContext?.state === "running";
  }

  getSharedAudioContext() {
    return this.getOrCreateSharedContext();
  }

  private async primeAudioElement({
    element
  }: PrimeAudioElementInput): Promise<RoomAudioElementPlayResult> {
    if (!element) {
      return {
        ok: false,
        error: "missing-audio-element"
      };
    }

    const hadSrcObject = !!element.srcObject;
    const hadSrc = !!element.currentSrc || !!element.getAttribute("src");
    const originalMuted = element.muted;
    const originalVolume = element.volume;
    const originalPreload = element.preload;
    let usedSilentSource = false;
    let primingSucceeded = false;

    try {
      element.muted = true;
      element.volume = 0;
      element.preload = "auto";

      // Prime the concrete media element inside the user gesture even before the
      // real room audio source is attached, otherwise the later async play() can
      // be treated as autoplay and produce "progress is moving but no sound yet".
      if (!hadSrcObject && !hadSrc) {
        element.src = SILENT_WAV_DATA_URI;
        this.safeCall(() => element.load());
        usedSilentSource = true;
      }

      await element.play();
      primingSucceeded = true;
      return {
        ok: true,
        error: null
      };
    } catch (error) {
      // Priming is best-effort only. Some embedded webviews and custom shells
      // throw synchronously on media mutations; callers should continue without
      // letting playback gestures crash the whole app.
      return {
        ok: false,
        error: error instanceof Error ? error.message : "play-rejected"
      };
    } finally {
      // Keep the successful silent resource playing. If the WebRTC stream is
      // attached after this gesture, the same media element can continue
      // without a second autoplay decision. A failed prime must still leave
      // the element untouched for the next user gesture.
      if (!primingSucceeded && usedSilentSource) {
        this.safeCall(() => element.pause());
        this.safeCall(() => element.removeAttribute("src"));
        this.safeCall(() => element.load());
      }

      element.preload = originalPreload;
      element.muted = originalMuted;
      element.volume = originalVolume;
    }
  }

  async resumeSharedAudioContext() {
    const context = this.getOrCreateSharedContext();
    if (!context) {
      return false;
    }
    this.installLifecycleListeners(context);
    if (context.state === "running") {
      return true;
    }
    if (context.state === "closed") {
      return false;
    }

    if (this.resumeInFlight) {
      return this.resumeInFlight;
    }

    const resume = context.resume().then(
      () => context.state === "running",
      () => false
    );
    this.resumeInFlight = resume;
    try {
      return await resume;
    } finally {
      if (this.resumeInFlight === resume) {
        this.resumeInFlight = null;
      }
    }
  }

  private installLifecycleListeners(context: AudioContext | null) {
    if (
      !context ||
      this.lifecycleListenersInstalled ||
      typeof window === "undefined"
    ) {
      return;
    }

    this.lifecycleListenersInstalled = true;
    const isContextSuspended = () =>
      context.state === "suspended" || (context.state as string) === "interrupted";
    const resumeWhenVisible = () => {
      if (
        this.activated &&
        isContextSuspended() &&
        (typeof document === "undefined" || !document.hidden)
      ) {
        void this.resumeSharedAudioContext();
      }
    };
    const handleStateChange = () => {
      if (this.activated && isContextSuspended()) {
        // Attempt an immediate resume even in background tabs so transient OS or
        // output-device transitions recover without waiting for foreground focus.
        void this.resumeSharedAudioContext();
      }
    };
    window.addEventListener("pageshow", resumeWhenVisible);
    window.addEventListener("focus", resumeWhenVisible);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", resumeWhenVisible);
    }
    context.addEventListener?.("statechange", handleStateChange);
  }

  private getOrCreateSharedContext() {
    if (typeof window === "undefined") {
      return null;
    }

    if (this.sharedContext) {
      return this.sharedContext;
    }

    const AudioContextCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextCtor) {
      return null;
    }

    try {
      this.sharedContext = new AudioContextCtor();
      return this.sharedContext;
    } catch {
      return null;
    }
  }

  private safeCall(action: () => void) {
    try {
      action();
    } catch {
      // Ignore one-off media element failures during priming cleanup.
    }
  }

  private rememberElementSource(element: HTMLAudioElement) {
    this.playedElementSourceKeys.set(element, this.getElementSourceKey(element));
  }

  private getElementSourceKey(element: HTMLAudioElement) {
    const srcObject = element.srcObject;
    if (srcObject) {
      return `srcObject:${this.getSourceObjectId(srcObject)}`;
    }

    const currentSrc = element.src || this.safeGetAttribute(element, "src") || element.currentSrc;
    return currentSrc ? `src:${currentSrc}` : "src:none";
  }

  private getSourceObjectId(sourceObject: object) {
    const existingId = this.sourceObjectIds.get(sourceObject);
    if (existingId) {
      return existingId;
    }

    const nextId = this.nextSourceObjectId;
    this.nextSourceObjectId += 1;
    this.sourceObjectIds.set(sourceObject, nextId);
    return nextId;
  }

  private safeGetAttribute(element: HTMLAudioElement, name: string) {
    try {
      return element.getAttribute(name);
    } catch {
      return null;
    }
  }
}

export const roomAudioActivationManager = new RoomAudioActivationManager();

function isAutoplayBlockedError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "NotAllowedError"
    : error instanceof Error && /not\s*allowed|autoplay|user gesture|blocked/i.test(error.message);
}
