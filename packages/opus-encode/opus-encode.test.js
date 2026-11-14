import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import createOpusEncoder from "./opus-encode.js";

test("encodes PCM without an external WASM asset", async () => {
  const encoder = await createOpusEncoder({
    sampleRate: 48_000,
    channels: 1,
    bitrate: 96,
    application: "audio"
  });

  try {
    const head = encoder.encode([new Float32Array(48_000 / 10)]);
    const tail = encoder.flush();
    const payload = new Uint8Array(head.byteLength + tail.byteLength);
    payload.set(head, 0);
    payload.set(tail, head.byteLength);
    assert.equal(new TextDecoder().decode(payload.subarray(0, 4)), "OggS");
    const opusHeadOffset = payload.findIndex((value, index) =>
      index + 8 <= payload.byteLength &&
      new TextDecoder().decode(payload.subarray(index, index + 8)) === "OpusHead"
    );
    assert.ok(opusHeadOffset >= 0);
    assert.equal(new DataView(payload.buffer).getUint16(opusHeadOffset + 10, true), 312);
  } finally {
    encoder.free();
  }
});

test("reuses the codec for independent Ogg units", async () => {
  const encoder = await createOpusEncoder({
    sampleRate: 48_000,
    channels: 1,
    bitrate: 96,
    application: "audio"
  });

  try {
    const first = encoder.encodeIndependent([new Float32Array(9_600)]);
    const second = encoder.encodeIndependent([new Float32Array(9_600)]);
    for (const payload of [first, second]) {
      assert.equal(new TextDecoder().decode(payload.subarray(0, 4)), "OggS");
      const opusHeadOffset = payload.findIndex((value, index) =>
        index + 8 <= payload.byteLength &&
        new TextDecoder().decode(payload.subarray(index, index + 8)) === "OpusHead"
      );
      assert.ok(opusHeadOffset >= 0);
    }
  } finally {
    encoder.free();
  }
});

test("resamples both streaming and independent non-48kHz input", async () => {
  const encoder = await createOpusEncoder({
    sampleRate: 44_100,
    channels: 1,
    bitrate: 96,
    application: "audio"
  });

  try {
    const input = Float32Array.from({ length: 44_100 }, (_, index) => Math.sin(index / 19));
    const streamed = new Uint8Array([
      ...encoder.encode([input.subarray(0, 22_050)]),
      ...encoder.encode([input.subarray(22_050)]),
      ...encoder.flush()
    ]);
    const independent = encoder.encodeIndependent([input]);
    assert.equal(new TextDecoder().decode(streamed.subarray(0, 4)), "OggS");
    assert.equal(new TextDecoder().decode(independent.subarray(0, 4)), "OggS");
  } finally {
    encoder.free();
  }
});

test("encodes without dynamic code generation under strict CSP (--disallow-code-generation-from-strings)", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const moduleUrl = pathToFileURL(path.join(dir, "opus-encode.js")).href;
  const script = `
    import assert from "node:assert/strict";
    import createOpusEncoder from ${JSON.stringify(moduleUrl)};

    assert.throws(() => new Function("return 1"), EvalError);

    const encoder = await createOpusEncoder({
      sampleRate: 48_000,
      channels: 2,
      bitrate: 128,
      application: "audio"
    });
    try {
      const left = Float32Array.from({ length: 9_600 }, (_, i) => Math.sin(i / 17) * 0.5);
      const right = Float32Array.from({ length: 9_600 }, (_, i) => Math.cos(i / 19) * 0.5);
      const head = encoder.encode([left, right]);
      const tail = encoder.flush();
      const streamed = new Uint8Array(head.byteLength + tail.byteLength);
      streamed.set(head, 0);
      streamed.set(tail, head.byteLength);
      const independent = encoder.encodeIndependent([left, right]);
      for (const payload of [streamed, independent]) {
        assert.equal(new TextDecoder().decode(payload.subarray(0, 4)), "OggS");
        assert.ok(payload.byteLength > 64);
      }
    } finally {
      encoder.free();
    }
  `;

  execFileSync(
    process.execPath,
    ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
    { encoding: "utf8" }
  );
});
