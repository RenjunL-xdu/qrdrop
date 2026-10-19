import {
  TYPE_DATA,
  TYPE_METADATA,
  buildMetadataPayload,
  decodeFrame,
  encodeFrame,
  makeSessionId,
  parseMetadataPayload,
  toHex,
  PROTOCOL_VERSION
} from "./protocol.js";
import {
  FountainDecoder,
  FountainEncoder,
  planChunks
} from "./fountain.js";

export const PROFILES = {
  stable: {
    id: "stable",
    label: "稳定",
    qrVersion: 18,
    qrCapacity: 560,
    blockSize: 512,
    fps: 9,
    note: "模块更大，适合手机屏幕和较远距离"
  },
  balanced: {
    id: "balanced",
    label: "均衡",
    qrVersion: 22,
    qrCapacity: 779,
    blockSize: 704,
    fps: 12,
    note: "速度与识别率的折中"
  },
  fast: {
    id: "fast",
    label: "高速",
    qrVersion: 27,
    qrCapacity: 1125,
    blockSize: 1024,
    fps: 16,
    note: "信息更密，适合电脑大屏和近距离对焦"
  }
};

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const KDF_ITERATIONS = 150000;
export const METADATA_EVERY = 16;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class PasswordRequiredError extends Error {
  constructor() {
    super("此文件已加密，请输入发送方设置的密码");
    this.code = "password-required";
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super("密码不正确，文件尚未解密");
    this.code = "wrong-password";
  }
}

export class VerificationError extends Error {
  constructor(message = "文件校验失败，请重新接收") {
    super(message);
    this.code = "verification-failed";
  }
}

export function sanitizeFileName(name) {
  const base = String(name || "received-file")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .trim();
  const chars = Array.from(base || "received-file");
  if (chars.length <= 180) return chars.join("");

  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? Array.from(base.slice(dot, dot + 16)) : [];
  return `${chars.slice(0, Math.max(1, 180 - extension.length)).join("")}${extension.join("")}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export async function maybeCompress(bytes) {
  if (bytes.length < 512 || typeof CompressionStream === "undefined") {
    return { data: bytes, compressed: false };
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (compressed.length < bytes.length * 0.98) {
      return { data: compressed, compressed: true };
    }
  } catch {
    // Compression is optional; raw bytes are always valid.
  }
  return { data: bytes, compressed: false };
}

export async function maybeDecompress(bytes, compressed) {
  if (!compressed) return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持解压此文件，请换用新版 Chrome、Edge 或 Safari");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveKey(password, salt, iterations) {
  const material = await globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptBytes(bytes, password) {
  if (!password || Array.from(password).length < 4) {
    throw new Error("密码至少需要 4 个字符");
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const encrypted = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return {
    data: new Uint8Array(encrypted),
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv)
  };
}

export async function decryptBytes(bytes, password, saltText, ivText, iterations) {
  if (!password) throw new PasswordRequiredError();
  try {
    const salt = base64UrlToBytes(saltText);
    const iv = base64UrlToBytes(ivText);
    const key = await deriveKey(password, salt, iterations);
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      bytes
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new WrongPasswordError();
  }
}

export async function prepareFile(file, profile, options = {}) {
  if (!file) throw new Error("请选择一个文件");
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`单文件上限为 ${formatBytes(MAX_FILE_BYTES)}`);
  }

  const raw = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(raw);
  const compression = options.compress === false
    ? { data: raw, compressed: false }
    : await maybeCompress(raw);

  let data = compression.data;
  let salt = "";
  let iv = "";
  let encrypted = false;
  const password = options.password || "";
  if (password) {
    const result = await encryptBytes(data, password);
    data = result.data;
    salt = result.salt;
    iv = result.iv;
    encrypted = true;
  }

  const chunks = planChunks(data.length, profile.blockSize);
  const name = sanitizeFileName(file.name);
  const metadata = {
    v: PROTOCOL_VERSION,
    n: name,
    m: file.type || "application/octet-stream",
    b: raw.length,
    d: data.length,
    h: hash,
    bs: profile.blockSize,
    c: chunks.length,
    z: compression.compressed ? 1 : 0,
    e: encrypted ? 1 : 0
  };
  if (encrypted) {
    metadata.k = KDF_ITERATIONS;
    metadata.sa = salt;
    metadata.iv = iv;
  }

  return {
    name,
    mime: file.type || "application/octet-stream",
    originalSize: raw.length,
    data,
    hash,
    compressed: compression.compressed,
    encrypted,
    metadata,
    sessionId: makeSessionId(),
    profile: profile.id
  };
}

export class QRSender {
  constructor(prepared, profile) {
    this.prepared = prepared;
    this.profile = profile;
    this.metadataPayload = buildMetadataPayload(prepared.metadata, profile.qrCapacity);
    this.metadataFrame = encodeFrame({
      type: TYPE_METADATA,
      sessionId: prepared.sessionId,
      payload: this.metadataPayload
    });
    this.chunks = planChunks(prepared.data.length, profile.blockSize);
    this.encoders = this.chunks.map((chunk) =>
      new FountainEncoder(
        prepared.data.subarray(chunk.offset, chunk.offset + chunk.length),
        profile.blockSize
      )
    );
    this.nextEsi = this.chunks.map(() => 0);
    this.frameIndex = 0;
    this.dataIndex = 0;
  }

  get sessionId() {
    return this.prepared.sessionId;
  }

  get estimatedBytesPerSecond() {
    return this.profile.blockSize * this.profile.fps * (1 - 3 / METADATA_EVERY);
  }

  nextFrame() {
    const frameNo = this.frameIndex++;
    const metadataFrame = frameNo < 2 || frameNo % METADATA_EVERY === 0;
    if (metadataFrame) {
      return {
        bytes: this.metadataFrame,
        kind: "metadata",
        frameNo,
        chunkIndex: 0,
        esi: 0
      };
    }

    const chunkIndex = this.dataIndex % this.chunks.length;
    const esi = this.nextEsi[chunkIndex]++;
    const symbol = this.encoders[chunkIndex].symbol(esi);
    const bytes = encodeFrame({
      type: TYPE_DATA,
      sessionId: this.prepared.sessionId,
      chunkIndex,
      esi,
      payload: symbol
    });
    this.dataIndex++;
    return { bytes, kind: "data", frameNo, chunkIndex, esi };
  }
}

export class QRReceiver {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.sessionId = null;
    this.metadata = null;
    this.chunks = [];
    this.decoders = [];
    this.totalBlocks = 0;
    this.seenData = new Set();
    this.seenQueue = [];
    this.receivedFrames = 0;
    this.duplicateFrames = 0;
    this.assembled = null;
    this.ready = false;
    this.readyNotified = false;
    this.lastMetadataAt = 0;
  }

  reset() {
    this.sessionId = null;
    this.metadata = null;
    this.chunks = [];
    this.decoders = [];
    this.totalBlocks = 0;
    this.seenData.clear();
    this.seenQueue = [];
    this.receivedFrames = 0;
    this.duplicateFrames = 0;
    this.assembled = null;
    this.ready = false;
    this.readyNotified = false;
    this.lastMetadataAt = 0;
  }

  ingest(bytes) {
    const frame = decodeFrame(bytes);
    if (!frame) return "invalid";

    if (frame.type === TYPE_METADATA) {
      let metadata;
      try {
        metadata = parseMetadataPayload(frame.payload);
      } catch (error) {
        this.callbacks.onError?.(error);
        return "invalid-metadata";
      }
      this.lastMetadataAt = performance.now();
      if (frame.sessionId !== this.sessionId) {
        this._beginSession(frame.sessionId, metadata);
        return "metadata";
      }
      this.metadata = metadata;
      return "metadata";
    }

    if (frame.type !== TYPE_DATA || frame.sessionId !== this.sessionId) return "ignored";
    const decoder = this.decoders[frame.chunkIndex];
    if (!decoder || decoder.complete || this.ready) return "ignored";

    const key = `${frame.chunkIndex}:${frame.esi}`;
    if (this.seenData.has(key)) {
      this.duplicateFrames++;
      return "duplicate";
    }
    this.seenData.add(key);
    this.seenQueue.push(key);
    if (this.seenQueue.length > 8192) this.seenData.delete(this.seenQueue.shift());

    this.receivedFrames++;
    decoder.add(frame.esi, frame.payload);
    this._emitProgress();
    if (this._allComplete()) {
      this.ready = true;
      if (!this.readyNotified) {
        this.readyNotified = true;
        this.callbacks.onReady?.(this.metadata);
      }
    }
    return "data";
  }

  _beginSession(sessionId, metadata) {
    const planned = planChunks(metadata.dataSize, metadata.blockSize);
    if (planned.length !== metadata.chunks) {
      throw new Error("二维码中的分片信息不一致");
    }

    this.reset();
    this.sessionId = sessionId;
    this.metadata = metadata;
    this.chunks = planned;
    this.decoders = planned.map((chunk) =>
      new FountainDecoder(chunk.blocks, metadata.blockSize, chunk.length)
    );
    this.totalBlocks = planned.reduce((sum, chunk) => sum + chunk.blocks, 0);
    this.callbacks.onSession?.({ sessionId, metadata });
    this._emitProgress();
  }

  _allComplete() {
    return this.decoders.length > 0 && this.decoders.every((decoder) => decoder.complete);
  }

  _emitProgress() {
    if (!this.metadata) return;
    let recoveredBlocks = 0;
    let chunksDone = 0;
    for (const decoder of this.decoders) {
      recoveredBlocks += decoder.recovered;
      if (decoder.complete) chunksDone++;
    }
    this.callbacks.onProgress?.({
      metadata: this.metadata,
      sessionId: this.sessionId,
      recoveredBlocks,
      totalBlocks: this.totalBlocks,
      chunksDone,
      chunks: this.decoders.length,
      progress: this.totalBlocks ? recoveredBlocks / this.totalBlocks : 0,
      receivedFrames: this.receivedFrames,
      duplicateFrames: this.duplicateFrames
    });
  }

  async finalize(password = "") {
    if (!this.ready || !this._allComplete()) throw new Error("文件还没有接收完整");
    if (!this.assembled) {
      const body = new Uint8Array(this.metadata.dataSize);
      for (let i = 0; i < this.decoders.length; i++) {
        const result = this.decoders[i].result();
        if (!result) throw new Error(`第 ${i + 1} 个分片不完整`);
        body.set(result, this.chunks[i].offset);
      }
      this.assembled = body;
    }

    let data = this.assembled;
    if (this.metadata.encrypted) {
      if (!password) throw new PasswordRequiredError();
      data = await decryptBytes(
        data,
        password,
        this.metadata.salt,
        this.metadata.iv,
        this.metadata.kdfIterations
      );
    }
    if (this.metadata.compressed) {
      data = await maybeDecompress(data, true);
    }

    if (data.length !== this.metadata.originalSize) {
      throw new VerificationError("文件长度校验失败，请重新接收");
    }
    const hash = await sha256Hex(data);
    if (hash !== this.metadata.hash) {
      throw new VerificationError("SHA-256 校验失败，请重新接收");
    }

    const blob = new Blob([data], { type: this.metadata.mime });
    return {
      blob,
      data,
      name: sanitizeFileName(this.metadata.name),
      mime: this.metadata.mime,
      size: data.length,
      hash
    };
  }
}
