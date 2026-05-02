export function computeShannonEntropyByte(bytes, start, end) {
  const lo = Math.max(0, start | 0);
  const hi = Math.max(lo, Math.min(bytes?.length || 0, end | 0));
  const len = hi - lo;
  if (len <= 0 || !bytes?.length) return 0;

  const counts = new Uint16Array(256);
  for (let i = lo; i < hi; i++) counts[bytes[i] & 0xff]++;

  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const count = counts[i];
    if (!count) continue;
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  const normalized = entropy / 8;
  const quantized = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
  return Math.max(0, Math.min(255, quantized | 0));
}
