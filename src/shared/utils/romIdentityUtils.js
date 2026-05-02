export function normalizePhysicalRom(physicalRom, opts = {}) {
  const { nullIfUnknown = false, setForMultiple = false } = opts || {};
  const unknown = nullIfUnknown ? null : { kind: 'unknown', romOffsets: [] };
  if (!physicalRom || typeof physicalRom !== 'object') return unknown;
  const vals = Array.isArray(physicalRom.romOffsets)
    ? Array.from(new Set(physicalRom.romOffsets
        .map((off) => (typeof off === 'number' ? off : Number(off)))
        .filter((off) => Number.isFinite(off) && off >= 0)
        .map((off) => off >>> 0))).sort((a, b) => a - b)
    : [];
  if (!vals.length) return unknown;
  return { kind: vals.length === 1 ? 'exact' : ((setForMultiple || physicalRom.kind === 'set') ? 'set' : 'exact'), romOffsets: vals };
}

export function physicalRomKey(physicalRom) {
  const norm = normalizePhysicalRom(physicalRom);
  if (!norm || norm.kind === 'unknown' || !norm.romOffsets.length) return 'phys:unknown';
  return `phys:${norm.kind}:${norm.romOffsets.join(',')}`;
}
