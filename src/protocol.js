export const MAGIC = new Uint8Array([0x51, 0x52, 0x46, 0x32]); // QRF2
export const PROTOCOL_VERSION = 2;
export const FRAME_HEADER_BYTES = 18;
export const TYPE_METADATA = 0;
export const TYPE_DATA = 1;
export const MAX_CHUNK_INDEX = 0xffff;
export const MAX_ESI = 0xffffff;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function updateCrc(crc, bytes, start, end) {
  let value = crc;
  for (let i = start; i < end; i++) {
    value = crcTable[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

export function crc32(bytes) {
  return (updateCrc(0xffffffff, bytes, 0, bytes.length) ^ 0xffffffff) >>> 0;
}

function frameCrc(bytes) {
  let value = updateCrc(0xffffffff, bytes, 0, 14);
  value = updateCrc(value, bytes, FRAME_HEADER_BYTES, bytes.length);
  return (value ^ 0xffffffff) >>> 0;
}

export function encodeFrame({
  type,
  sessionId,
  chunkIndex = 0,
  esi = 0,
  payload = new Uint8Array()
}) {
  if (type !== TYPE_METADATA && type !== TYPE_DATA) throw new RangeError("Unknown frame type");
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) {
    throw new RangeError("Invalid session id");
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_CHUNK_INDEX) {
    throw new RangeError("Invalid chunk index");
  }
  if (!Number.isInteger(esi) || esi < 0 || esi > MAX_ESI) {
    throw new RangeError("Invalid ESI");
  }

  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint8(4, type);
  view.setUint32(5, sessionId, false);
  view.setUint16(9, chunkIndex, false);
  view.setUint8(11, (esi >>> 16) & 0xff);
  view.setUint8(12, (esi >>> 8) & 0xff);
  view.setUint8(13, esi & 0xff);
  out.set(payload, FRAME_HEADER_BYTES);
  view.setUint32(14, frameCrc(out), false);
  return out;
}

export function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
  if (bytes.length < FRAME_HEADER_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }

  const type = bytes[4];
  if (type !== TYPE_METADATA && type !== TYPE_DATA) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expected = view.getUint32(14, false);
  if (frameCrc(bytes) !== expected) return null;

  return {
    type,
    sessionId: view.getUint32(5, false),
    chunkIndex: view.getUint16(9, false),
    esi: (bytes[11] << 16) | (bytes[12] << 8) | bytes[13],
    payload: Uint8Array.from(bytes.subarray(FRAME_HEADER_BYTES))
  };
}

export function makeSessionId() {
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] || 1;
  }
  return ((Math.random() * 0xfffffffe) >>> 0) + 1;
}

export function utf8Length(value) {
  return textEncoder.encode(value).length;
}

function truncateName(name, maxCodePoints) {
  const chars = Array.from(name);
  if (chars.length <= maxCodePoints) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? Array.from(name.slice(dot, dot + 13)) : [];
  const keep = Math.max(1, maxCodePoints - extension.length - 1);
  return `${chars.slice(0, keep).join("").trimEnd()}…${extension.join("")}`;
}

export function buildMetadataPayload(metadata, maxFrameBytes = Infinity) {
  const maxPayloadBytes = Math.max(0, maxFrameBytes - FRAME_HEADER_BYTES);
  const required = ["n", "m", "b", "d", "h", "bs", "c", "z", "e"];
  for (const key of required) {
    if (metadata[key] === undefined) throw new TypeError(`Missing metadata field: ${key}`);
  }

  let name = String(metadata.n);
  let payload = JSON.stringify({ ...metadata, n: name });
  if (utf8Length(payload) <= maxPayloadBytes) return textEncoder.encode(payload);

  const chars = Array.from(name);
  let keep = chars.length;
  while (keep > 1) {
    keep = Math.max(1, Math.floor(keep * 0.86));
    name = truncateName(metadata.n, keep);
    payload = JSON.stringify({ ...metadata, n: name });
    if (utf8Length(payload) <= maxPayloadBytes) return textEncoder.encode(payload);
  }

  throw new RangeError("File metadata does not fit in one QR frame");
}

function validBase64Url(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  if (value.length % 4 === 1) return false;
  if (expectedLength === undefined) return true;
  return Math.floor(value.length * 3 / 4) === expectedLength;
}

export function parseMetadataPayload(payload) {
  let value;
  try {
    value = JSON.parse(textDecoder.decode(payload));
  } catch {
    throw new Error("二维码中的文件信息无法解析");
  }

  if (value?.v !== PROTOCOL_VERSION) throw new Error("二维码协议版本不兼容");
  if (typeof value.n !== "string" || !value.n) throw new Error("文件名为空");
  if (typeof value.m !== "string") throw new Error("文件类型缺失");
  if (!Number.isSafeInteger(value.b) || value.b < 0) throw new Error("文件大小无效");
  if (!Number.isSafeInteger(value.d) || value.d < 0) throw new Error("数据大小无效");
  if (!/^[a-f0-9]{64}$/i.test(value.h || "")) throw new Error("文件校验值无效");
  if (!Number.isInteger(value.bs) || value.bs < 64 || value.bs > 2048) throw new Error("数据块大小无效");
  if (!Number.isInteger(value.c) || value.c < 1 || value.c > MAX_CHUNK_INDEX + 1) {
    throw new Error("分片数量无效");
  }
  if (value.z !== 0 && value.z !== 1) throw new Error("压缩标记无效");
  if (value.e !== 0 && value.e !== 1) throw new Error("加密标记无效");
  if (value.e) {
    if (!Number.isInteger(value.k) || value.k < 10000 || value.k > 1000000) {
      throw new Error("密钥派生参数无效");
    }
    if (!validBase64Url(value.sa, 16) || !validBase64Url(value.iv, 12)) {
      throw new Error("加密参数无效");
    }
  }

  return {
    version: value.v,
    name: value.n,
    mime: value.m,
    originalSize: value.b,
    dataSize: value.d,
    hash: value.h.toLowerCase(),
    blockSize: value.bs,
    chunks: value.c,
    compressed: value.z === 1,
    encrypted: value.e === 1,
    kdfIterations: value.k || 0,
    salt: value.sa || "",
    iv: value.iv || ""
  };
}

export function bytesToBinaryString(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
