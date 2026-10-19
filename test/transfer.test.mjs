import assert from "node:assert/strict";
import test from "node:test";
import {
  PROFILES,
  QRReceiver,
  QRSender,
  WrongPasswordError,
  prepareFile
} from "../src/transfer.js";

function makeFile(bytes, name = "传输测试.txt", type = "text/plain") {
  return new File([bytes], name, { type });
}

function runStream(prepared, profile, options = {}) {
  const sender = new QRSender(prepared, profile);
  let ready = false;
  const receiver = new QRReceiver({
    onReady: () => {
      ready = true;
    }
  });
  const dropRate = options.dropRate ?? 0;
  const maxFrames = options.maxFrames ?? 20_000;
  let seed = options.seed ?? 7;

  for (let i = 0; i < maxFrames && !ready; i++) {
    const frame = sender.nextFrame();
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (frame.kind === "data" && seed / 0x100000000 < dropRate) continue;
    receiver.ingest(frame.bytes);
    if (options.duplicateEvery && i % options.duplicateEvery === 0) {
      receiver.ingest(frame.bytes);
    }
  }
  return { receiver, ready, sender };
}

test("plain file survives a lossy QR stream", async () => {
  const original = new TextEncoder().encode(
    "码渡测试。\n".repeat(1200) + JSON.stringify({ answer: 42, ok: true })
  );
  const prepared = await prepareFile(makeFile(original), PROFILES.stable, {
    compress: false
  });
  const { receiver, ready } = runStream(prepared, PROFILES.stable, {
    dropRate: 0.35,
    duplicateEvery: 9
  });
  assert.equal(ready, true);
  const result = await receiver.finalize();
  assert.equal(result.name, "传输测试.txt");
  assert.deepEqual(result.data, original);
});

test("compressed file is restored with the original name", async () => {
  const text = "这是一个容易压缩的文本文件。\n".repeat(2500);
  const prepared = await prepareFile(
    makeFile(new TextEncoder().encode(text), "说明文件.txt"),
    PROFILES.balanced,
    { compress: true }
  );
  assert.equal(prepared.compressed, true);
  const { receiver, ready } = runStream(prepared, PROFILES.balanced, {
    dropRate: 0.25
  });
  assert.equal(ready, true);
  const result = await receiver.finalize();
  assert.equal(new TextDecoder().decode(result.data), text);
  assert.equal(result.name, "说明文件.txt");
});

test("encrypted transfer rejects the wrong password and accepts the right one", async () => {
  const original = Uint8Array.from({ length: 8000 }, (_, index) => (index * 19) & 0xff);
  const prepared = await prepareFile(
    makeFile(original, "secret.bin", "application/octet-stream"),
    PROFILES.stable,
    { compress: false, password: "codex-123" }
  );
  assert.equal(prepared.encrypted, true);
  const { receiver, ready } = runStream(prepared, PROFILES.stable, {
    dropRate: 0.2
  });
  assert.equal(ready, true);
  await assert.rejects(receiver.finalize("wrong-password"), WrongPasswordError);
  const result = await receiver.finalize("codex-123");
  assert.deepEqual(result.data, original);
});

test("a payload spanning multiple fountain chunks is reassembled", async () => {
  let value = 0x5174;
  const original = Uint8Array.from({ length: 260_000 }, () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value >>> 24;
  });
  const prepared = await prepareFile(
    makeFile(original, "large.bin", "application/octet-stream"),
    PROFILES.stable,
    { compress: false }
  );
  const { receiver, ready } = runStream(prepared, PROFILES.stable, {
    dropRate: 0.18,
    maxFrames: 40_000
  });
  assert.equal(ready, true);
  const result = await receiver.finalize();
  assert.deepEqual(result.data, original);
});
