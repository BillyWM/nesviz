import { normalizePhysicalRom } from '../../utils/romIdentityUtils.js';

function tableForOffsets(tables, offsets) {
  if (!offsets?.length) return null;
  let found = null;
  for (const table of tables || []) {
    const start = table.romStart >>> 0;
    const end = table.romEnd >>> 0;
    if (!offsets.every((off) => off >= start && off < end)) continue;
    if (found) return null;
    found = table;
  }
  return found;
}

function pairOffsets(lowOffsets, highOffsets) {
  if (!lowOffsets?.length || !highOffsets?.length) return false;
  const lowSet = new Set(lowOffsets.map((off) => off >>> 0));
  const highSet = new Set(highOffsets.map((off) => off >>> 0));
  for (const low of lowSet) if (!highSet.has((low + 1) >>> 0)) return false;
  for (const high of highSet) if (!lowSet.has((high - 1) >>> 0)) return false;
  return true;
}

function lineByRomOff(displayBlock, romOff) {
  const target = romOff >>> 0;
  return (displayBlock?.lines || []).find((line) => (line?.romOff >>> 0) === target) || null;
}

function lineIndexByRomOff(displayBlock, romOff) {
  const target = romOff >>> 0;
  const lines = Array.isArray(displayBlock?.lines) ? displayBlock.lines : [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.romOff >>> 0) === target) return i;
  }
  return null;
}

function seedFromObservation({ role, obs, displayBlock, table, physicalOffsets }) {
  const line = lineByRomOff(displayBlock, obs.atRomOff);
  const lineIndex = lineIndexByRomOff(displayBlock, obs.atRomOff);
  const firstOffset = physicalOffsets?.[0];
  return {
    role,
    rawBlockId: typeof obs?.rawBlockId === 'string' ? obs.rawBlockId : null,
    lineIndex,
    lineRomOff: obs.atRomOff >>> 0,
    lineCpuAddr: typeof obs?.cpuAddr === 'number' ? (obs.cpuAddr & 0xffff) : null,
    dstReg: typeof obs?.dstReg === 'string' ? obs.dstReg : null,
    mode: typeof line?.mode === 'string' ? line.mode : null,
    indexKind: typeof obs?.addrFlow?.indexReg === 'string' ? obs.addrFlow.indexReg : 'none',
    operandCpuAddr: Number.isFinite(obs?.addrFlow?.baseCpuAddr) ? (obs.addrFlow.baseCpuAddr & 0xffff) : null,
    tableByteIndex: Number.isFinite(firstOffset) ? ((firstOffset >>> 0) - (table.romStart >>> 0)) : null,
    tableRomOff: Number.isFinite(firstOffset) ? (firstOffset >>> 0) : null,
    observationId: typeof obs?.id === 'string' ? obs.id : null
  };
}

function readerKey(table, displayBlock, lowObs, highObs) {
  return `${table.id}:${displayBlock.id}:${lowObs.atRomOff >>> 0}:${highObs.atRomOff >>> 0}`;
}

export function discoverMonotoneReadersFromVsa({ displayBlock, monotoneTables, observations }) {
  const reads = [];
  for (const obs of observations || []) {
    if (obs?.kind !== 'read8') continue;
    if (obs?.src?.space !== 'rom') continue;
    const physical = normalizePhysicalRom(obs?.src?.physicalRom || obs?.addrFlow?.physicalRom, { nullIfUnknown: true, setForMultiple: true });
    if (!physical?.romOffsets?.length) continue;
    const table = tableForOffsets(monotoneTables, physical.romOffsets);
    if (!table) continue;
    reads.push({ obs, table, physical });
  }
  reads.sort((a, b) => (a.obs.atRomOff >>> 0) - (b.obs.atRomOff >>> 0));

  const readersByTable = new Map();
  const seen = new Set();
  for (let i = 0; i < reads.length; i++) {
    const low = reads[i];
    for (let j = i + 1; j < Math.min(reads.length, i + 6); j++) {
      const high = reads[j];
      if (low.table.id !== high.table.id) continue;
      if (!pairOffsets(low.physical.romOffsets, high.physical.romOffsets)) continue;
      const key = readerKey(low.table, displayBlock, low.obs, high.obs);
      if (seen.has(key)) continue;
      seen.add(key);
      const reader = {
        origin: 'vsa',
        rawBlockId: typeof low.obs?.rawBlockId === 'string' ? low.obs.rawBlockId : null,
        displayBlockId: displayBlock.id,
        cpuAddr: typeof low.obs?.cpuAddr === 'number' ? (low.obs.cpuAddr & 0xffff) : null,
        romOff: low.obs.atRomOff >>> 0,
        pairLineIndexes: [lineIndexByRomOff(displayBlock, low.obs.atRomOff), lineIndexByRomOff(displayBlock, high.obs.atRomOff)],
        pairLineRomOffs: [low.obs.atRomOff >>> 0, high.obs.atRomOff >>> 0],
        pairLineCpuAddrs: [typeof low.obs?.cpuAddr === 'number' ? (low.obs.cpuAddr & 0xffff) : null, typeof high.obs?.cpuAddr === 'number' ? (high.obs.cpuAddr & 0xffff) : null],
        readSeeds: [
          seedFromObservation({ role: 'low', obs: low.obs, displayBlock, table: low.table, physicalOffsets: low.physical.romOffsets }),
          seedFromObservation({ role: 'high', obs: high.obs, displayBlock, table: low.table, physicalOffsets: high.physical.romOffsets })
        ],
        seedRomOffStart: low.obs.atRomOff >>> 0,
        seedRomOffEnd: high.obs?.basis?.romOffSpan?.end ?? (high.obs.atRomOff >>> 0),
        evidence: {
          pairedByteRead: true,
          adjacentZpStores: false,
          usedForRead: false,
          indexKind: typeof low.obs?.addrFlow?.indexReg === 'string' ? low.obs.addrFlow.indexReg : 'none',
          tableByteIndex: (low.physical.romOffsets[0] >>> 0) - (low.table.romStart >>> 0),
          indirectMode: null,
          indirectMnemonic: null
        },
        promotes: false
      };
      if (!readersByTable.has(low.table.id)) readersByTable.set(low.table.id, []);
      readersByTable.get(low.table.id).push(reader);
    }
  }
  return readersByTable;
}
