/// <reference lib="webworker" />

import createOpusEncoder from "@audio/opus-encode";

type EncodeRequest =
  | {
      type?: "encode";
      id: number;
      sampleRate: number;
      channels: Float32Array[];
      bitrateKbps: 128 | 256;
    }
  | {
      type: "dispose";
    };

type EncodeResponse =
  | { id: number; ok: true; payload: ArrayBuffer }
  | { id: number; ok: false; error: string };

type OpusEncoder = Awaited<ReturnType<typeof createOpusEncoder>>;

let encoder: OpusEncoder | null = null;
let encoderConfig: string | null = null;

async function getEncoder(request: Extract<EncodeRequest, { id: number }>) {
  const nextConfig = `${request.sampleRate}:${request.channels.length}:${request.bitrateKbps}`;
  if (encoder && encoderConfig === nextConfig) {
    return encoder;
  }

  encoder?.free();
  encoder = null;
  encoderConfig = null;
  const nextEncoder = await createOpusEncoder({
    sampleRate: request.sampleRate,
    channels: request.channels.length,
    bitrate: request.bitrateKbps,
    application: "audio"
  });
  encoder = nextEncoder;
  encoderConfig = nextConfig;
  return encoder;
}

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const request = event.data;
  if (request.type === "dispose") {
    encoder?.free();
    encoder = null;
    encoderConfig = null;
    self.close();
    return;
  }
  try {
    const opusEncoder = await getEncoder(request);
    const encoded = await opusEncoder.encodeIndependent(request.channels);
    const payload = encoded.buffer as ArrayBuffer;
    const response: EncodeResponse = { id: request.id, ok: true, payload };
    self.postMessage(response, { transfer: [payload] });
  } catch (error) {
    const response: EncodeResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Opus encoding failed."
    };
    self.postMessage(response);
  }
};

export {};
