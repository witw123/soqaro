import { describe, expect, it } from "vitest";
import {
  maximumAudioBitrateKbps,
  preferredAudioRtpBitrateKbps,
  resolveFanoutAudioBitrateKbps,
  resolveFixedAudioBitrateKbps
} from "./audio-bitrate-policy";

describe("fixed RTP audio bitrate policy", () => {
  it("keeps the preferred target below the codec maximum", () => {
    expect(preferredAudioRtpBitrateKbps).toBe(320);
    expect(preferredAudioRtpBitrateKbps).toBeLessThan(maximumAudioBitrateKbps);
    expect(maximumAudioBitrateKbps).toBe(510);
  });

  it("clamps valid requests to the policy range", () => {
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: 64 })).toBe(64);
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: 192 })).toBe(192);
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: 320 })).toBe(320);
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: 1_000 })).toBe(510);
  });

  it("does not change a requested target without network degradation", () => {
    const requests = [64, 192, 320, 510];
    const results = requests.map((requestedKbps) =>
      resolveFixedAudioBitrateKbps({ requestedKbps })
    );

    expect(results).toEqual(requests);
  });

  it("keeps invalid requests disabled", () => {
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: null })).toBeNull();
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: 0 })).toBeNull();
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: -1 })).toBeNull();
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: Number.NaN })).toBeNull();
    expect(resolveFixedAudioBitrateKbps({ requestedKbps: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe("fan-out RTP audio bitrate policy", () => {
  it("keeps a stable target across a ten-member fan-out", () => {
    expect(resolveFanoutAudioBitrateKbps({ fanout: 1, requestedKbps: 510 })).toBe(320);
    expect(resolveFanoutAudioBitrateKbps({ fanout: 2, requestedKbps: 510 })).toBe(320);
    expect(resolveFanoutAudioBitrateKbps({ fanout: 5, requestedKbps: 510 })).toBe(320);
    expect(resolveFanoutAudioBitrateKbps({ fanout: 9, requestedKbps: 510 })).toBe(320);
  });

  it("does not create a sender target without listeners", () => {
    expect(resolveFanoutAudioBitrateKbps({ fanout: 0, requestedKbps: 320 })).toBeNull();
    expect(resolveFanoutAudioBitrateKbps({ fanout: 1, requestedKbps: null })).toBeNull();
  });
});
