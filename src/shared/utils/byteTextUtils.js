export function parseBytesText(bytesText, opts = {}) {
  const { strict = true } = opts || {};
  if (!bytesText || typeof bytesText !== 'string') return [];
  const parts = bytesText.split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const v = Number.parseInt(p, 16);
    if (!Number.isFinite(v)) {
      if (strict) return [];
      continue;
    }
    out.push(v & 0xff);
  }
  return out;
}
