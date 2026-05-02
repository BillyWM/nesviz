export function getSafeRomHash(romHash, context = 'cache') {
  const hash = String(romHash || '').trim();
  if (!hash) throw new Error(`Missing ROM hash for ${context}`);
  return hash.replace(/[^a-zA-Z0-9_-]/g, '_');
}
