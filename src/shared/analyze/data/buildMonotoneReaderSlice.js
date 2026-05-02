function lineEnd(line) {
  const start = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : 0;
  const len = typeof line?.len === 'number' ? (line.len >>> 0) : 0;
  return (start + len) >>> 0;
}

function observationId(obs, rawId = 'na') {
  if (typeof obs?.id === 'string' || typeof obs?.id === 'number') return String(obs.id);
  return `${rawId}:${obs?.kind ?? 'obs'}:${obs?.atRomOff ?? 'na'}`;
}

function readSeedLineIndex(seed) {
  return Number.isFinite(seed?.lineIndex) ? (seed.lineIndex | 0) : null;
}

function storeSourceReg(line) {
  if (line?.mnemonic === 'STA') return 'A';
  if (line?.mnemonic === 'STX') return 'X';
  if (line?.mnemonic === 'STY') return 'Y';
  return null;
}

function loadDestReg(line) {
  if (line?.mnemonic === 'LDA') return 'A';
  if (line?.mnemonic === 'LDX') return 'X';
  if (line?.mnemonic === 'LDY') return 'Y';
  return null;
}

function transfer(line) {
  switch (line?.mnemonic) {
    case 'TAX': return { from: 'A', to: 'X' };
    case 'TAY': return { from: 'A', to: 'Y' };
    case 'TXA': return { from: 'X', to: 'A' };
    case 'TYA': return { from: 'Y', to: 'A' };
    default: return null;
  }
}

function sameRegTransform(line, reg) {
  if (reg !== 'A') return false;
  return (line?.mnemonic === 'ASL' || line?.mnemonic === 'LSR' || line?.mnemonic === 'ROL' || line?.mnemonic === 'ROR') && line?.mode === 'acc';
}

function accumulatorDerivedTransform(line) {
  const mnemonic = line?.mnemonic;
  if ((mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') && line?.mode === 'acc') return true;
  return mnemonic === 'ADC' || mnemonic === 'SBC' || mnemonic === 'AND' || mnemonic === 'ORA' || mnemonic === 'EOR';
}

function carrySetup(line) {
  return line?.mnemonic === 'CLC' || line?.mnemonic === 'SEC';
}

function carrySensitiveAccumulatorTransform(line) {
  const mnemonic = line?.mnemonic;
  return mnemonic === 'ADC' || mnemonic === 'SBC' || ((mnemonic === 'ROL' || mnemonic === 'ROR') && line?.mode === 'acc');
}

function mutatesReg(line, reg) {
  if (loadDestReg(line) === reg) return true;
  if ((line?.mnemonic === 'ADC' || line?.mnemonic === 'SBC' || line?.mnemonic === 'AND' || line?.mnemonic === 'ORA' || line?.mnemonic === 'EOR') && reg === 'A') return true;
  if ((line?.mnemonic === 'INX' || line?.mnemonic === 'DEX') && reg === 'X') return true;
  if ((line?.mnemonic === 'INY' || line?.mnemonic === 'DEY') && reg === 'Y') return true;
  const xfer = transfer(line);
  if (xfer?.to === reg) return true;
  if (sameRegTransform(line, reg)) return true;
  return false;
}

function lineIndexByRomOff(block, romOff) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  const target = romOff >>> 0;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.romOff >>> 0) === target) return i;
  }
  return null;
}

function observationsByRomOff(observations) {
  const out = new Map();
  for (const obs of observations || []) {
    if (!Number.isFinite(obs?.atRomOff)) continue;
    const key = obs.atRomOff >>> 0;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(obs);
  }
  return out;
}

function addForwardOutputSlice({ lineIndexes, seed, block }) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  const start = readSeedLineIndex(seed);
  const dstReg = typeof seed?.dstReg === 'string' ? seed.dstReg : null;
  if (start == null || !dstReg) return;
  const live = new Set([dstReg]);
  let pendingCarrySetupLineIndex = null;
  lineIndexes.add(start);
  for (let i = start + 1; i < lines.length && live.size; i++) {
    const line = lines[i];

    if (live.has('A') && carrySetup(line)) {
      pendingCarrySetupLineIndex = i;
      continue;
    }

    const storeReg = storeSourceReg(line);
    if (storeReg && live.has(storeReg)) {
      lineIndexes.add(i);
      continue;
    }

    const xfer = transfer(line);
    if (xfer && live.has(xfer.from)) {
      lineIndexes.add(i);
      live.add(xfer.to);
      continue;
    }

    if (live.has('A') && accumulatorDerivedTransform(line)) {
      if (pendingCarrySetupLineIndex != null && carrySensitiveAccumulatorTransform(line)) {
        lineIndexes.add(pendingCarrySetupLineIndex);
      }
      lineIndexes.add(i);
      pendingCarrySetupLineIndex = null;
      continue;
    }

    pendingCarrySetupLineIndex = null;
    for (const reg of Array.from(live)) {
      if (sameRegTransform(line, reg)) {
        lineIndexes.add(i);
        continue;
      }
      if (mutatesReg(line, reg)) live.delete(reg);
    }
  }
}

function addGlobalInputSlice({ lineIndexes, reader, observations, block }) {
  const seedIds = new Set(Array.isArray(reader?.seedObservationIds) ? reader.seedObservationIds : []);
  const seedUses = new Set(Array.isArray(reader?.seedUses) ? reader.seedUses : []);
  if (!seedUses.size && !seedIds.size) return;
  for (const obs of observations || []) {
    const id = observationId(obs);
    if (seedIds.has(id)) {
      const idx = lineIndexByRomOff(block, obs.atRomOff);
      if (idx != null) lineIndexes.add(idx);
      continue;
    }
    if (obs?.kind !== 'valueFlow8') continue;
    const defs = new Set(obs?.defs || []);
    let matches = false;
    for (const use of seedUses) if (defs.has(use)) matches = true;
    if (!matches) continue;
    const idx = lineIndexByRomOff(block, obs.atRomOff);
    if (idx != null) lineIndexes.add(idx);
  }
}

export function buildMonotoneReaderSlice({ reader, displayBlock, observations }) {
  if (!reader?.verified) return null;
  const lines = Array.isArray(displayBlock?.lines) ? displayBlock.lines : [];
  if (!lines.length) return null;
  const lineIndexes = new Set();
  const inputLineIndexes = [];
  const seedLineIndexes = [];
  const outputLineIndexes = [];

  for (const idx of reader?.localProof?.inputLineIndexes || []) {
    if (Number.isFinite(idx) && idx >= 0 && idx < lines.length) {
      lineIndexes.add(idx | 0);
      inputLineIndexes.push(idx | 0);
    }
  }

  addGlobalInputSlice({ lineIndexes, reader, observations, block: displayBlock });

  for (const seed of reader.readSeeds || []) {
    const idx = readSeedLineIndex(seed);
    if (idx == null || idx < 0 || idx >= lines.length) continue;
    lineIndexes.add(idx);
    seedLineIndexes.push(idx);
    const before = new Set(lineIndexes);
    addForwardOutputSlice({ lineIndexes, seed, block: displayBlock });
    for (const added of lineIndexes) {
      if (!before.has(added) && added !== idx) outputLineIndexes.push(added);
    }
  }

  if (!lineIndexes.size) return null;
  const ordered = Array.from(lineIndexes).sort((a, b) => a - b);
  const startLine = lines[ordered[0]];
  const endLine = lines[ordered[ordered.length - 1]];
  if (!Number.isFinite(startLine?.romOff) || !Number.isFinite(endLine?.romOff)) return null;

  const byRomOff = observationsByRomOff(observations);
  const evidenceIds = new Set(Array.isArray(reader?.seedObservationIds) ? reader.seedObservationIds : []);
  for (const idx of ordered) {
    const romOff = lines[idx]?.romOff;
    if (!Number.isFinite(romOff)) continue;
    for (const obs of byRomOff.get(romOff >>> 0) || []) evidenceIds.add(observationId(obs));
  }

  const span = { start: startLine.romOff >>> 0, end: lineEnd(endLine) };
  return {
    readRegionSpan: span,
    anchorRomOff: span.start,
    anchorCpuAddr: typeof startLine.cpuAddr === 'number' ? (startLine.cpuAddr & 0xffff) : null,
    inputLineRomOffs: Array.from(new Set(inputLineIndexes)).sort((a, b) => a - b).map((idx) => lines[idx]?.romOff).filter(Number.isFinite).map((off) => off >>> 0),
    seedLineRomOffs: Array.from(new Set(seedLineIndexes)).sort((a, b) => a - b).map((idx) => lines[idx]?.romOff).filter(Number.isFinite).map((off) => off >>> 0),
    outputLineRomOffs: Array.from(new Set(outputLineIndexes)).sort((a, b) => a - b).map((idx) => lines[idx]?.romOff).filter(Number.isFinite).map((off) => off >>> 0),
    involvedLineRomOffs: ordered.map((idx) => lines[idx]?.romOff).filter(Number.isFinite).map((off) => off >>> 0),
    evidenceObservationIds: Array.from(evidenceIds).sort()
  };
}
