// Systematic LT fountain code with a peeling decoder.
// A receiver can miss, repeat or reorder QR frames without corrupting the file.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cdfCache = new Map();

function solitonCdf(K, c = 0.05, delta = 0.01) {
  const key = `${K}:${c}:${delta}`;
  if (cdfCache.has(key)) return cdfCache.get(key);

  const R = Math.max(1, c * Math.log(K / delta) * Math.sqrt(K));
  const pivot = Math.max(1, Math.round(K / R));
  const p = new Float64Array(K + 1);

  for (let d = 1; d <= K; d++) {
    const rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
    let tau = 0;
    if (d < pivot) tau = R / (d * K);
    else if (d === pivot) tau = (R * Math.log(R / delta)) / K;
    p[d] = rho + tau;
  }

  let beta = 0;
  for (let d = 1; d <= K; d++) beta += p[d];

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += p[d] / beta;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  cdfCache.set(key, cdf);
  return cdf;
}

function sampleDegree(cdf, K, u) {
  let lo = 1;
  let hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function indicesFor(esi, K) {
  if (esi < K) return [esi];
  const rnd = mulberry32(esi * 2654435761 + K);
  const cdf = solitonCdf(K);
  let degree = sampleDegree(cdf, K, rnd());
  if (degree > K) degree = K;
  if (K === 1) return [0];

  const picked = new Set();
  let guard = 0;
  while (picked.size < degree && guard++ < degree * 20) {
    picked.add(Math.floor(rnd() * K) % K);
  }
  return Array.from(picked);
}

export class FountainEncoder {
  constructor(data, blockSize) {
    this.blockSize = blockSize;
    this.dataLen = data.length;
    this.K = Math.max(1, Math.ceil(data.length / blockSize));
    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const block = new Uint8Array(blockSize);
      block.set(data.subarray(i * blockSize, Math.min((i + 1) * blockSize, data.length)));
      this.blocks.push(block);
    }
  }

  symbol(esi) {
    const ids = indicesFor(esi, this.K);
    const out = new Uint8Array(this.blockSize);
    for (const id of ids) {
      const block = this.blocks[id];
      for (let i = 0; i < this.blockSize; i++) out[i] ^= block[i];
    }
    return out;
  }
}

export class FountainDecoder {
  constructor(K, blockSize, dataLen) {
    this.K = K;
    this.blockSize = blockSize;
    this.dataLen = dataLen;
    this.blocks = new Array(K).fill(null);
    this.recovered = 0;
    this.pending = new Set();
    this.containing = new Map();
    this.received = 0;
  }

  get complete() {
    return this.recovered >= this.K;
  }

  get progress() {
    return this.recovered / this.K;
  }

  add(esi, data) {
    if (this.complete) return true;
    this.received++;

    const ids = new Set(indicesFor(esi, this.K));
    const val = Uint8Array.from(data);

    for (const id of Array.from(ids)) {
      if (this.blocks[id]) {
        this._xor(val, this.blocks[id]);
        ids.delete(id);
      }
    }
    if (ids.size === 0) return this.complete;

    const symbol = { ids, val };
    if (ids.size === 1) {
      this._resolve(symbol);
    } else {
      this.pending.add(symbol);
      for (const id of ids) {
        if (!this.containing.has(id)) this.containing.set(id, new Set());
        this.containing.get(id).add(symbol);
      }
    }
    return this.complete;
  }

  _xor(dst, src) {
    for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
  }

  _resolve(symbol) {
    const queue = [symbol];
    while (queue.length) {
      const current = queue.pop();
      if (current.ids.size !== 1) continue;
      const id = current.ids.values().next().value;
      if (this.blocks[id]) continue;

      this.blocks[id] = current.val;
      this.recovered++;

      const dependents = this.containing.get(id);
      if (!dependents) continue;
      this.containing.delete(id);
      for (const dependent of dependents) {
        if (!this.pending.has(dependent)) continue;
        this._xor(dependent.val, current.val);
        dependent.ids.delete(id);
        if (dependent.ids.size === 1) {
          this.pending.delete(dependent);
          for (const other of dependent.ids) this.containing.get(other)?.delete(dependent);
          queue.push(dependent);
        }
      }
    }
  }

  result() {
    if (!this.complete) return null;
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) out.set(this.blocks[i], i * this.blockSize);
    return out.subarray(0, this.dataLen);
  }

  get overhead() {
    return this.received / this.K;
  }
}

export const MAX_BLOCKS_PER_CHUNK = 384;

export function planChunks(dataLen, blockSize) {
  const totalBlocks = Math.max(1, Math.ceil(dataLen / blockSize));
  const chunkCount = Math.ceil(totalBlocks / MAX_BLOCKS_PER_CHUNK);
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const startBlock = i * MAX_BLOCKS_PER_CHUNK;
    const blocks = Math.min(MAX_BLOCKS_PER_CHUNK, totalBlocks - startBlock);
    const offset = startBlock * blockSize;
    chunks.push({
      index: i,
      offset,
      length: Math.min(blocks * blockSize, Math.max(0, dataLen - offset)),
      blocks
    });
  }
  return chunks;
}
