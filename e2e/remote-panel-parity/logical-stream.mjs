const MIB = 1024n * 1024n;
export const MAX_LOGICAL_STREAM_BYTES = 50n * 1024n * MIB;
export const DEFAULT_LOGICAL_CHUNK_BYTES = 8n * MIB;
export const LOGICAL_STREAM_SIZES = Object.freeze({
  small: 1n * MIB,
  boundary100MiB: 100n * MIB,
  logical50GiB: MAX_LOGICAL_STREAM_BYTES,
});

function asBytes(value, label) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^\d+$/u.test(text)) {
    throw new RangeError(`${label} must be a non-negative integer byte count`);
  }
  return BigInt(text);
}

function assertDescriptorRange(size, chunkSize) {
  if (size <= 0n || size > MAX_LOGICAL_STREAM_BYTES) {
    throw new RangeError('logical stream size must be between 1 byte and 50 GiB');
  }
  if (chunkSize <= 0n || chunkSize > DEFAULT_LOGICAL_CHUNK_BYTES) {
    throw new RangeError('logical stream chunk size must be between 1 byte and 8 MiB');
  }
}

export function createLogicalStreamDescriptor({
  sizeBytes = LOGICAL_STREAM_SIZES.logical50GiB,
  chunkBytes = DEFAULT_LOGICAL_CHUNK_BYTES,
  seed = 'rpp-020-logical-stream',
} = {}) {
  const size = asBytes(sizeBytes, 'sizeBytes');
  const chunkSize = asBytes(chunkBytes, 'chunkBytes');
  assertDescriptorRange(size, chunkSize);
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 128 || /[\u0000-\u001f\u007f]/u.test(seed)) {
    throw new RangeError('logical stream seed must be bounded printable text');
  }
  return Object.freeze({
    kind: 'logical-stream',
    sizeBytes: size.toString(),
    chunkBytes: chunkSize.toString(),
    seed,
    seekable: true,
    materialized: false,
    networked: false,
  });
}

function descriptorSize(descriptor) {
  if (!descriptor || descriptor.kind !== 'logical-stream') {
    throw new TypeError('invalid logical stream descriptor');
  }
  const size = asBytes(descriptor.sizeBytes, 'descriptor.sizeBytes');
  const chunkSize = asBytes(descriptor.chunkBytes, 'descriptor.chunkBytes');
  assertDescriptorRange(size, chunkSize);
  return { size, chunkSize, seed: descriptor.seed };
}

function patternFor(seed, offset) {
  const pattern = Buffer.allocUnsafe(64);
  let state = 0x811c9dc5;
  const text = `${seed}:${offset.toString()}`;
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  for (let index = 0; index < pattern.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pattern[index] = state & 0xff;
  }
  return pattern;
}

/**
 * Returns one bounded deterministic chunk. No 50 GiB file is allocated.
 */
export function readLogicalChunk(descriptor, offsetBytes, lengthBytes) {
  const { size, chunkSize, seed } = descriptorSize(descriptor);
  const offset = asBytes(offsetBytes, 'offsetBytes');
  const requested = asBytes(lengthBytes, 'lengthBytes');
  if (offset > size || requested > chunkSize || offset + requested > size) {
    throw new RangeError('logical stream read is outside the descriptor or exceeds its chunk bound');
  }
  const length = Number(requested);
  const chunk = Buffer.alloc(length);
  const pattern = patternFor(seed, offset - (offset % 64n));
  for (let index = 0; index < length; index += 1) {
    chunk[index] = pattern[Number((offset + BigInt(index)) % 64n)];
  }
  return chunk;
}

/**
 * Async iterator used by later transfer tests. It is seekable by descriptor
 * range, but it never opens a socket, file, object store, or child process.
 */
export async function* logicalByteStream(descriptor, { startBytes = 0n, endBytes = undefined } = {}) {
  const { size, chunkSize } = descriptorSize(descriptor);
  const start = asBytes(startBytes, 'startBytes');
  const end = endBytes === undefined ? size : asBytes(endBytes, 'endBytes');
  if (start > end || end > size) {
    throw new RangeError('logical stream range is invalid');
  }
  let offset = start;
  while (offset < end) {
    const remaining = end - offset;
    const length = remaining < chunkSize ? remaining : chunkSize;
    yield readLogicalChunk(descriptor, offset, length);
    offset += length;
  }
}

