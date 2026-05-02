function u16le(bytes, off = 1) {
  if (!Array.isArray(bytes) || (off + 1) >= bytes.length) return null;
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function operandCpuAddr(line) {
  const mode = line?.mode;
  if (mode !== 'abs' && mode !== 'absX' && mode !== 'absY' && mode !== 'zp' && mode !== 'zpX' && mode !== 'zpY' && mode !== 'indX' && mode !== 'indY') return null;
  if (mode === 'abs' || mode === 'absX' || mode === 'absY') return u16le(line?.bytes, 1);
  const b = Array.isArray(line?.bytes) && line.bytes.length > 1 ? line.bytes[1] : null;
  return typeof b === 'number' ? (b & 0xff) : null;
}

function loadRegisterForMnemonic(mnemonic) {
  if (mnemonic === 'LDA') return 'A';
  if (mnemonic === 'LDX') return 'X';
  if (mnemonic === 'LDY') return 'Y';
  return null;
}

function storeRegisterForMnemonic(mnemonic) {
  if (mnemonic === 'STA') return 'A';
  if (mnemonic === 'STX') return 'X';
  if (mnemonic === 'STY') return 'Y';
  return null;
}


function buildReadSeed({ role, rawBlockId, line, lineIndex, match, dstReg }) {
  return {
    role,
    rawBlockId,
    lineIndex,
    lineRomOff: typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null,
    lineCpuAddr: typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
    dstReg,
    mode: match?.mode || null,
    indexKind: match?.indexKind || 'none',
    operandCpuAddr: Number.isFinite(match?.operandCpuAddr) ? (match.operandCpuAddr & 0xffff) : null,
    tableByteIndex: Number.isFinite(match?.byteIndex) ? (match.byteIndex | 0) : null,
    tableRomOff: Number.isFinite(match?.romOff) ? (match.romOff >>> 0) : null
  };
}

function buildCpuAddressLookup(mapper, tables) {
  const byCpuAddr = new Map();
  for (const table of tables || []) {
    for (let off = table.romStart | 0; off < (table.romEnd | 0); off++) {
      const cpuAddrs = mapper?.romOffToCpuAddrs?.(off) || [];
      for (const cpuAddrRaw of cpuAddrs) {
        const cpuAddr = cpuAddrRaw & 0xffff;
        if (!byCpuAddr.has(cpuAddr)) byCpuAddr.set(cpuAddr, []);
        byCpuAddr.get(cpuAddr).push({
          tableId: table.id,
          romOff: off,
          byteIndex: (off - table.romStart) | 0
        });
      }
    }
  }
  return byCpuAddr;
}

function matchTableByte(line, cpuLookup) {
  const mode = line?.mode;
  if (mode !== 'abs' && mode !== 'absX' && mode !== 'absY') return [];
  const operand = operandCpuAddr(line);
  if (operand == null) return [];
  const matches = cpuLookup.get(operand & 0xffff) || [];
  return matches.map((match) => ({
    ...match,
    operandCpuAddr: operand & 0xffff,
    mode,
    indexKind: mode === 'absX' ? 'X' : mode === 'absY' ? 'Y' : 'none'
  }));
}

function findZpStore(lines, startExclusive, endExclusive, reg) {
  const start = Math.max(0, (startExclusive | 0) + 1);
  const end = Math.min(lines.length, endExclusive | 0);
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (storeRegisterForMnemonic(line?.mnemonic) !== reg) continue;
    if (line?.mode !== 'zp') continue;
    const zpAddr = operandCpuAddr(line);
    if (zpAddr == null) continue;
    return { i, reg, zpAddr: zpAddr & 0xff };
  }
  return null;
}

function findAdjacentZpStores(lines, lowLoadIndex, highLoadIndex, lowReg, highReg, maxWindow = 6) {
  const lowStore = findZpStore(lines, lowLoadIndex, Math.min(lines.length, highLoadIndex + 1), lowReg)
    || findZpStore(lines, lowLoadIndex, Math.min(lines.length, lowLoadIndex + 1 + maxWindow), lowReg);
  if (!lowStore) return null;

  const highStore = findZpStore(lines, highLoadIndex, Math.min(lines.length, highLoadIndex + 1 + maxWindow), highReg);
  if (!highStore) return null;
  if (((highStore.zpAddr - lowStore.zpAddr) & 0xff) !== 1) return null;

  return {
    lowStoreIndex: lowStore.i,
    highStoreIndex: highStore.i,
    zpBase: lowStore.zpAddr & 0xff
  };
}

function findIndirectRead(lines, startIndex, zpBase, maxWindow = 10) {
  const end = Math.min(lines.length, startIndex + 1 + maxWindow);
  for (let i = startIndex + 1; i < end; i++) {
    const line = lines[i];
    if (!line) continue;
    const mode = line.mode;
    if (mode !== 'indX' && mode !== 'indY') continue;
    const operand = operandCpuAddr(line);
    if (operand == null || ((operand & 0xff) !== (zpBase & 0xff))) continue;
    const mnemonic = typeof line.mnemonic === 'string' ? line.mnemonic : '';
    if (mnemonic === 'STA' || mnemonic === 'STX' || mnemonic === 'STY') continue;
    return {
      useLineIndex: i,
      mode,
      mnemonic,
      operand: operand & 0xff
    };
  }
  return null;
}

export function attachMonotoneTableReaders({ blocks, monotoneTables, mapper }) {
  const tables = Array.isArray(monotoneTables) ? monotoneTables.map((table) => ({ ...table, readers: [] })) : [];
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const cpuLookup = buildCpuAddressLookup(mapper, tables);

  for (const block of blocks || []) {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    if (!lines.length) continue;
    const readersByTable = new Map();

    for (let i = 0; i < lines.length; i++) {
      const lowLine = lines[i];
      const lowReg = loadRegisterForMnemonic(lowLine?.mnemonic);
      if (!lowReg) continue;
      const lowMatches = matchTableByte(lowLine, cpuLookup);
      if (!lowMatches.length) continue;

      for (let j = i + 1; j < Math.min(lines.length, i + 1 + 4); j++) {
        const highLine = lines[j];
        const highReg = loadRegisterForMnemonic(highLine?.mnemonic);
        if (!highReg) continue;
        const highMatches = matchTableByte(highLine, cpuLookup);
        if (!highMatches.length) continue;

        for (const low of lowMatches) {
          for (const high of highMatches) {
            if (low.tableId !== high.tableId) continue;
            if (low.mode !== high.mode) continue;
            if (low.indexKind !== high.indexKind) continue;
            if (((high.byteIndex - low.byteIndex) | 0) !== 1) continue;

            const zpStores = findAdjacentZpStores(lines, i, j, lowReg, highReg);
            const indirectRead = zpStores ? findIndirectRead(lines, zpStores.highStoreIndex, zpStores.zpBase) : null;
            const table = tableById.get(low.tableId);
            if (!table) continue;

            const lowLine = lines[i] || null;
            const highLine = lines[j] || null;
            const reader = {
              rawBlockId: block.id,
              cpuAddr: typeof lines[0]?.cpuAddr === 'number' ? (lines[0].cpuAddr & 0xffff) : null,
              romOff: typeof lines[0]?.romOff === 'number' ? (lines[0].romOff >>> 0) : null,
              pairLineIndexes: [i, j],
              pairLineRomOffs: [typeof lowLine?.romOff === 'number' ? (lowLine.romOff >>> 0) : null, typeof highLine?.romOff === 'number' ? (highLine.romOff >>> 0) : null],
              pairLineCpuAddrs: [typeof lowLine?.cpuAddr === 'number' ? (lowLine.cpuAddr & 0xffff) : null, typeof highLine?.cpuAddr === 'number' ? (highLine.cpuAddr & 0xffff) : null],
              readSeeds: [
                buildReadSeed({ role: 'low', rawBlockId: block.id, line: lowLine, lineIndex: i, match: low, dstReg: lowReg }),
                buildReadSeed({ role: 'high', rawBlockId: block.id, line: highLine, lineIndex: j, match: high, dstReg: highReg })
              ],
              origin: 'structural',
              seedRomOffStart: typeof lowLine?.romOff === 'number' ? (lowLine.romOff >>> 0) : null,
              seedRomOffEnd: (typeof highLine?.romOff === 'number' && typeof highLine?.len === 'number') ? ((highLine.romOff >>> 0) + (highLine.len >>> 0)) >>> 0 : null,
              zpBase: zpStores ? (zpStores.zpBase & 0xff) : null,
              evidence: {
                pairedByteRead: true,
                adjacentZpStores: !!zpStores,
                usedForRead: !!indirectRead,
                indexKind: low.indexKind,
                tableByteIndex: low.byteIndex,
                indirectMode: indirectRead?.mode || null,
                indirectMnemonic: indirectRead?.mnemonic || null
              },
              promotes: !!(zpStores && indirectRead)
            };

            const existing = readersByTable.get(low.tableId);
            if (!existing || (reader.promotes && !existing.promotes)) readersByTable.set(low.tableId, reader);
          }
        }
      }
    }

    for (const [tableId, reader] of readersByTable.entries()) {
      const table = tableById.get(tableId);
      if (!table) continue;
      table.readers.push(reader);
    }
  }

  for (const table of tables) {
    table.promotedToPointerTable = table.readers.some((reader) => !!reader.promotes);
    table.pointerInterpretation = table.promotedToPointerTable ? 'location16' : null;
  }

  return tables.sort((a, b) => a.romStart - b.romStart || a.romEnd - b.romEnd);
}
