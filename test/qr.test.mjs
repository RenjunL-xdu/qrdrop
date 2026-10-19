import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { encodeFrame, TYPE_DATA } from "../src/protocol.js";
import { PROFILES } from "../src/transfer.js";
import { renderQRToRgba } from "../src/qr.js";

const context = { self: {} };
vm.runInNewContext(readFileSync(new URL("../vendor/jsQR.js", import.meta.url), "utf8"), context);
const jsQR = context.self.jsQR;

function bytesFor(length, seed) {
  let value = seed >>> 0;
  return Uint8Array.from({ length }, () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value >>> 24;
  });
}

for (const profile of Object.values(PROFILES)) {
  test(`QR profile ${profile.id} decodes as raw binary`, () => {
    const payload = bytesFor(profile.blockSize, profile.qrVersion * 99);
    const frame = encodeFrame({
      type: TYPE_DATA,
      sessionId: 0x10203040,
      chunkIndex: 2,
      esi: 314,
      payload
    });
    const { rgba, size } = renderQRToRgba(frame, profile.qrVersion, 3);
    const decoded = jsQR(rgba, size, size, { inversionAttempts: "dontInvert" });
    assert.ok(decoded, "QR decoder returned no result");
    assert.deepEqual(Uint8Array.from(decoded.binaryData), frame);
  });
}
