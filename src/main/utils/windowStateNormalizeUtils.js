export function normalizeWindowKey(key) {
  if (!key) return null;
  const k = String(key).trim();
  if (!k) return null;
  return k.length > 80 ? k.slice(0, 80) : k;
}

export function normalizeWindowState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  const maximized = !!raw.maximized;

  const out = { maximized };
  if (Number.isFinite(x)) out.x = x | 0;
  if (Number.isFinite(y)) out.y = y | 0;
  if (Number.isFinite(width) && width > 0) out.width = width | 0;
  if (Number.isFinite(height) && height > 0) out.height = height | 0;
  return out;
}
