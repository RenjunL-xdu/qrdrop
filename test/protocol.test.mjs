import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_HEADER_BYTES,
  TYPE_DATA,
  TYPE_METADATA,
  buildMetadataPayload,
  bytesToBinaryString,
  decodeFrame,
  encodeFrame,
  parseMetadataPayload
} from "../src/protocol.js";

const metadata = {
  v: 2,
  n: "测试文件.txt",
  m: "text/plain",
  b: 1234,
  d: 1000,
  h: "a".repeat(64),
  bs: 512,
  c: 2,
  z: 0,
  e: 0
};

test("binary data frame survives encode and decode", () => {
  const payload = Uint8Array.from({ length: 512 }, (_, index) => (index * 37) & 0xff);
  const frame = encodeFrame({
    type: TYPE_DATA,
    sessionId: 0xdecafbad,
    chunkIndex: 3,
    esi: 70_000,
    payload
  });
  const parsed = decodeFrame(frame);
  assert.ok(parsed);
  assert.equal(parsed.type, TYPE_DATA);
  assert.equal(parsed.sessionId, 0xdecafbad);
  assert.equal(parsed.chunkIndex, 3);
  assert.equal(parsed.esi, 70_000);
  assert.deepEqual(parsed.payload, payload);
});

test("frame CRC rejects a changed byte", () => {
  const payload = Uint8Array.from([1, 2, 3, 4, 5]);
  const frame = encodeFrame({
    type: TYPE_DATA,
    sessionId: 42,
    chunkIndex: 0,
    esi: 0,
    payload
  });
  frame[FRAME_HEADER_BYTES + 2] ^= 0x80;
  assert.equal(decodeFrame(frame), null);
});

test("binary frame strings preserve bytes above 0x7f", () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 200, 255]);
  const text = bytesToBinaryString(bytes);
  assert.deepEqual(
    Array.from(text, (char) => char.charCodeAt(0)),
    Array.from(bytes)
  );
});

test("metadata can be shortened to fit the stable QR profile", () => {
  const longName = `${"很长的文件名".repeat(40)}.pdf`;
  const payload = buildMetadataPayload({ ...metadata, n: longName }, 560);
  const parsed = parseMetadataPayload(payload);
  assert.ok(payload.length + FRAME_HEADER_BYTES <= 560);
  assert.ok(parsed.name.endsWith(".pdf"));
  assert.ok(parsed.name.length < longName.length);
  assert.equal(parsed.originalSize, metadata.b);
});

test("metadata round-trips and validates encryption parameters", () => {
  const encrypted = {
    ...metadata,
    e: 1,
    k: 150000,
    sa: "AAAAAAAAAAAAAAAAAAAAAA",
    iv: "AAAAAAAAAAAAAAAA"
  };
  const payload = buildMetadataPayload(encrypted, 779);
  assert.equal(decodeFrame(encodeFrame({
    type: TYPE_METADATA,
    sessionId: 7,
    payload
  }))?.type, TYPE_METADATA);
  const parsed = parseMetadataPayload(payload);
  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.kdfIterations, 150000);
  assert.equal(parsed.salt.length, 22);
  assert.equal(parsed.iv.length, 16);
});
