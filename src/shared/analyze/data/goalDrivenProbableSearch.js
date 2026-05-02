import { OPCODES } from '../../cpu6502/opcodes.js';

const GOAL_READ_MNEMONICS = new Set(['LDA', 'LDX', 'LDY', 'CMP', 'ADC', 'SBC', 'AND', 'ORA', 'EOR', 'BIT']);

function findUnknownRanges(codeBitmap, minLen) {
  const bm = codeBitmap || new Uint8Array(0);
  const ranges = [];
  let i = 0;
  while (i < bm.length) {
    while (i < bm.length && bm[i] !== 0) i++;
    const start = i;
    while (i < bm.length && bm[i] === 0) i++;
    const end = i;
    if ((end - start) >= (minLen | 0)) ranges.push({ start, end });
  }
  return ranges;
}

function buildUnresolvedTableAddressSets(mapper, tables) {
  const cpuAddrToTables = new Map();
  const unresolvedTables = (tables || []).filter((table) => !table.promotedToPointerTable);
  for (const table of unresolvedTables) {
    for (let off = table.romStart | 0; off < (table.romEnd | 0); off++) {
      const cpuAddrs = mapper?.romOffToCpuAddrs?.(off) || [];
      for (const cpuAddrRaw of cpuAddrs) {
        const cpuAddr = cpuAddrRaw & 0xffff;
        if (!cpuAddrToTables.has(cpuAddr)) cpuAddrToTables.set(cpuAddr, []);
        cpuAddrToTables.get(cpuAddr).push(table.id);
      }
    }
  }
  return cpuAddrToTables;
}

export function deriveGoalDrivenProbeOffsets({ prgBytes, mapper, codeBitmap, monotoneTables, config }) {
  const outOffsets = new Set();
  const cpuAddrToTables = buildUnresolvedTableAddressSets(mapper, monotoneTables);
  const perTableHitCount = new Map();
  const minRangeBytes = Math.max(4, (config.minUnknownRangeBytes ?? 16) | 0);
  const maxHitsPerTable = Math.max(1, (config.goalDrivenMaxRawHitsPerTable ?? 24) | 0);
  const backtrack = Math.max(0, (config.goalDrivenBacktrackBytes ?? 8) | 0);
  const unknownRanges = findUnknownRanges(codeBitmap, minRangeBytes);

  for (const range of unknownRanges) {
    for (let off = range.start; (off + 2) < range.end; off++) {
      const opcode = OPCODES[prgBytes[off] & 0xff];
      if (!opcode) continue;
      if (opcode.mode !== 'abs' && opcode.mode !== 'absX' && opcode.mode !== 'absY') continue;
      if (!GOAL_READ_MNEMONICS.has(opcode.mnemonic)) continue;
      const cpuAddr = (prgBytes[off + 1] | (prgBytes[off + 2] << 8)) & 0xffff;
      const tableIds = cpuAddrToTables.get(cpuAddr);
      if (!tableIds || !tableIds.length) continue;

      for (const tableId of tableIds) {
        const hitCount = perTableHitCount.get(tableId) || 0;
        if (hitCount >= maxHitsPerTable) continue;
        perTableHitCount.set(tableId, hitCount + 1);
        const probeStart = Math.max(range.start, off - backtrack);
        outOffsets.add(probeStart | 0);
      }
    }
  }

  return {
    probeOffsets: Array.from(outOffsets).sort((a, b) => a - b),
    stats: {
      unresolvedTableCount: (monotoneTables || []).filter((table) => !table.promotedToPointerTable).length,
      rawHitCount: Array.from(perTableHitCount.values()).reduce((sum, n) => sum + n, 0),
      probeOffsetCount: outOffsets.size,
      perTableHitCount: Object.fromEntries(Array.from(perTableHitCount.entries()))
    }
  };
}
