const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function updateCrc32(crc, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected a Node Buffer');

  let c = crc >>> 0;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC32_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

export function crc32(buffer) {
  const crc = updateCrc32(0xffffffff, buffer);
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32Buffers(buffers) {
  if (!Array.isArray(buffers)) throw new Error('Expected an array of Buffers');

  let crc = 0xffffffff;
  for (const buffer of buffers) {
    if (!buffer || buffer.length === 0) continue;
    crc = updateCrc32(crc, buffer);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32Hex(buffer) {
  return crc32(buffer).toString(16).toUpperCase().padStart(8, '0');
}

export function crc32HexBuffers(buffers) {
  return crc32Buffers(buffers).toString(16).toUpperCase().padStart(8, '0');
}
