export const minimumAudioBitrateKbps = 64;
export const audioBitrateStepKbps = 8;
export const maximumAudioBitrateKbps = 510;

// A source sends one RTP stream per listener. Keep the normal target below the
// codec ceiling so the ten-member fan-out has predictable upload headroom.
export const preferredAudioRtpBitrateKbps = 320;

// This is an application-level budget for the audio fan-out, excluding a
// small amount of RTP/DTLS/ICE overhead. The per-peer floor is retained for
// very large rooms, where a relay would be the correct long-term architecture.
export const sourceAudioUploadBudgetKbps = 3_600;

export type FixedAudioBitrateInput = {
  requestedKbps: number | null;
};

/** Clamp a requested sender bitrate to the Opus policy range. */
export function resolveFixedAudioBitrateKbps(input: FixedAudioBitrateInput) {
  return normalizeBitrate(input.requestedKbps);
}

export type FanoutAudioBitrateInput = {
  fanout: number;
  requestedKbps: number | null;
};

/**
 * Allocate a stable sender bitrate from topology, before any per-peer stats
 * are available. For the supported ten-member room this value is unchanged
 * when listeners join; the budget is only a guard for larger rooms.
 */
export function resolveFanoutAudioBitrateKbps(input: FanoutAudioBitrateInput) {
  const requestedKbps = normalizeBitrate(input.requestedKbps);
  if (
    requestedKbps === null ||
    !Number.isFinite(input.fanout) ||
    input.fanout <= 0
  ) {
    return null;
  }

  // The supported room size is ten members, so joining a listener does not
  // retune already-playing senders. Larger rooms use deterministic lower tiers
  // until the product has a server-side media relay.
  const fanoutTierKbps = input.fanout <= 10
    ? preferredAudioRtpBitrateKbps
    : input.fanout <= 16
      ? 256
      : input.fanout <= 24
        ? 192
        : minimumAudioBitrateKbps;
  const budgetShareKbps = sourceAudioUploadBudgetKbps / input.fanout;
  return quantizeBitrate(Math.min(requestedKbps, fanoutTierKbps, budgetShareKbps));
}

function normalizeBitrate(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(
    maximumAudioBitrateKbps,
    Math.max(minimumAudioBitrateKbps, Math.round(value))
  );
}

function quantizeBitrate(value: number) {
  const clampedValue = Math.min(
    maximumAudioBitrateKbps,
    Math.max(minimumAudioBitrateKbps, value)
  );
  if (clampedValue >= maximumAudioBitrateKbps) {
    return maximumAudioBitrateKbps;
  }
  return Math.max(
    minimumAudioBitrateKbps,
    Math.floor(clampedValue / audioBitrateStepKbps) * audioBitrateStepKbps
  );
}
