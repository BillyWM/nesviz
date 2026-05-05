export function getPrgRegionSizeBytes(analysisMapper, prgSize) {
  const meta = analysisMapper || null;
  if (meta?.prgWindowModel === 'mmc1-variable') return 16 * 1024;
  const swap = Number(meta?.prgSwapUnitBytes);
  if (Number.isFinite(swap) && swap > 0) return swap | 0;
  const slots = Array.isArray(meta?.prgFetchLayout?.slots) ? meta.prgFetchLayout.slots : [];
  const slotSizes = slots
    .map((slot) => Number(slot?.sizeBytes))
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => a - b);
  if (slotSizes.length) return slotSizes[0] | 0;
  return Math.max(1, prgSize | 0);
}
