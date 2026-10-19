import assert from "node:assert/strict";
import test from "node:test";
import {
  FountainDecoder,
  FountainEncoder,
  MAX_BLOCKS_PER_CHUNK,
  indicesFor,
  planChunks
} from "../src/fountain.js";

function prng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

test("fountain indices are deterministic", () => {
  for (const esi of [0, 4, 99, 1000, 999999]) {
    assert.deepEqual(indicesFor(esi, 64), indicesFor(esi, 64));
  }
});

test("peeling decoder recovers a payload with 40% frames missing", () => {
  const random = prng(12345);
  const blockSize = 128;
  const data = Uint8Array.from({ length: 12_000 }, () => Math.floor(random() * 256));
  const encoder = new FountainEncoder(data, blockSize);
  const decoder = new FountainDecoder(encoder.K, blockSize, data.length);
  let esi = 0;
  let attempts = 0;

  while (!decoder.complete && attempts < encoder.K * 8) {
    const symbol = encoder.symbol(esi++);
    attempts++;
    if (random() < 0.4) continue;
    decoder.add(esi - 1, symbol);
  }

  assert.equal(decoder.complete, true);
  assert.deepEqual(Buffer.from(decoder.result()), Buffer.from(data));
  assert.ok(decoder.overhead < 2);
});

test("chunk planning bounds the decoder working set", () => {
  const blockSize = 512;
  const dataLength = blockSize * MAX_BLOCKS_PER_CHUNK * 2 + 100;
  const chunks = planChunks(dataLength, blockSize);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].blocks, MAX_BLOCKS_PER_CHUNK);
  assert.equal(chunks[1].blocks, MAX_BLOCKS_PER_CHUNK);
  assert.equal(chunks[2].blocks, 1);
  assert.equal(chunks.at(-1).offset + chunks.at(-1).length, dataLength);
});
