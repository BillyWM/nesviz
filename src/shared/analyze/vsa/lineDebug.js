import { fmtHex } from '../../utils/numberUtils.js';
import { uniqueSortedNumbers, uniqueSortedStrings } from '../../utils/uniqueUtils.js';

function lineEnd(line) {
  const start = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
  if (start === null) return null;
  const len = typeof line?.len === 'number'
    ? (line.len >>> 0)
    : (typeof line?.bytesText === 'string' ? line.bytesText.trim().split(/\s+/).filter(Boolean).length : 1);
  return (start + Math.max(1, len || 1)) >>> 0;
}

function sourceText(src, addrFlow) {
  const space = src?.space || null;
  if (!space) return 'unknown';
  if (space === 'rom') {
    const base = typeof addrFlow?.baseCpuAddr === 'number'
      ? `$${fmtHex(addrFlow.baseCpuAddr, 4)}`
      : (typeof src?.addr === 'number' ? `$${fmtHex(src.addr, 4)}` : 'rom');
    const suffix = addrFlow?.indexReg ? `,${addrFlow.indexReg}` : '';
    return `${base}${suffix}`;
  }
  if (space === 'zp') return `zp:$${fmtHex(src.addr ?? addrFlow?.cpuAddr ?? 0, 2)}`;
  if (space === 'ram') return `ram:$${fmtHex(src.addr ?? addrFlow?.cpuAddr ?? 0, 4)}`;
  if (space === 'prgram') return `prgram:$${fmtHex(src.addr ?? addrFlow?.cpuAddr ?? 0, 4)}`;
  if (space === 'io') return `io:$${fmtHex(src.addr ?? addrFlow?.cpuAddr ?? 0, 4)}`;
  return `${space}:$${fmtHex(src?.addr ?? 0, 4)}`;
}

function dstText(dst) {
  if (!dst?.space) return 'unknown';
  if (dst.space === 'zp') return `zp:$${fmtHex(dst.addr ?? 0, 2)}`;
  if (dst.space === 'io') return `io:$${fmtHex(dst.addr ?? 0, 4)}`;
  if (dst.space === 'ram') return `ram:$${fmtHex(dst.addr ?? 0, 4)}`;
  if (dst.space === 'prgram') return `prgram:$${fmtHex(dst.addr ?? 0, 4)}`;
  return `${dst.space}:$${fmtHex(dst.addr ?? 0, 4)}`;
}

function smallNumberSetText(values, width = 2, cap = 16) {
  const vals = uniqueSortedNumbers(values);
  if (!vals.length) return '';
  const shown = vals.slice(0, cap).map((v) => `$${fmtHex(v, width)}`).join(',');
  return vals.length > cap ? `{${shown},… +${vals.length - cap}}` : `{${shown}}`;
}

function physicalRomText(physicalRom) {
  const vals = uniqueSortedNumbers(physicalRom?.romOffsets || []);
  if (!vals.length) return '';
  if (physicalRom?.kind === 'exact' && vals.length === 1) return `rom=$${fmtHex(vals[0], 6)}`;
  return `rom=${smallNumberSetText(vals, 6, 8)}`;
}

function flowDetails(obs) {
  const details = [];
  const uses = uniqueSortedStrings(obs?.uses || []);
  const defs = uniqueSortedStrings(obs?.defs || []);
  const inputProvIds = uniqueSortedNumbers(obs?.inputProvIds || []);
  const outputProvIds = uniqueSortedNumbers(obs?.outputProvIds || []);
  const span = obs?.basis?.romOffSpan;
  if (uses.length) details.push(`uses ${uses.join(', ')}`);
  if (defs.length) details.push(`defs ${defs.join(', ')}`);
  if (inputProvIds.length) details.push(`inProv ${inputProvIds.join(',')}`);
  if (outputProvIds.length) details.push(`outProv ${outputProvIds.join(',')}`);
  if (span && typeof span.start === 'number' && typeof span.end === 'number') {
    details.push(`span ${fmtHex(span.start, 6)}-${fmtHex(span.end, 6)}`);
  }
  return details;
}

function formatObservation(obs) {
  const details = flowDetails(obs);
  switch (obs?.kind) {
    case 'read8': {
      const src = sourceText(obs.src, obs.addrFlow);
      const dst = obs.dstReg ? obs.dstReg : '?';
      const parts = [`read8 ${src} -> ${dst}`];
      const indexVals = smallNumberSetText(obs?.addrFlow?.indexValues || [], 2, 16);
      if (indexVals) parts.push(`index=${indexVals}`);
      const phys = physicalRomText(obs?.addrFlow?.physicalRom || obs?.src?.physicalRom);
      if (phys) parts.push(phys);
      if (obs?.addrFlow?.indexValueSource) parts.push(`indexSource=${obs.addrFlow.indexValueSource}`);
      return { kind: 'read8', text: parts.join('; '), details };
    }
    case 'store8': {
      const src = obs.srcReg || '?';
      const dst = dstText(obs.dst);
      return { kind: 'store8', text: `store8 ${src} -> ${dst}`, details };
    }
    case 'valueFlow8': {
      const op = obs.opKind || obs.mnemonic || 'flow';
      const imm = typeof obs.imm === 'number' ? ` #$${fmtHex(obs.imm, 2)}` : '';
      const src = (op === 'immLoad' && typeof obs.imm === 'number')
        ? `#$${fmtHex(obs.imm, 2)}`
        : (Array.isArray(obs.srcRegs) && obs.srcRegs.length ? obs.srcRegs.join(',') : '?');
      const dst = obs.dstReg || (obs.dst?.space ? dstText(obs.dst) : '?');
      return { kind: 'valueFlow8', text: `valueFlow8 ${op}${imm}: ${src} -> ${dst}`, details };
    }
    case 'cmp8': {
      let rhs = '?';
      if (obs.rhs?.kind === 'imm') rhs = `#$${fmtHex(obs.rhs.imm ?? 0, 2)}`;
      else if (obs.rhs?.src) rhs = sourceText(obs.rhs.src, obs.rhs.src);
      return { kind: 'cmp8', text: `cmp8 ${obs.reg || '?'} vs ${rhs}`, details };
    }
    case 'zpPtr16': {
      const zp = typeof obs.zpAddr === 'number' ? `$${fmtHex(obs.zpAddr, 2)}/$${fmtHex((obs.zpAddr + 1) & 0xff, 2)}` : 'zp:?';
      const value = typeof obs.value16 === 'number' ? ` -> $${fmtHex(obs.value16, 4)}` : '';
      return { kind: 'zpPtr16', text: `zpPtr16 ${zp}${value}`, details };
    }
    case 'branchFlagUse': {
      const branch = obs.branch || {};
      const source = obs.source || null;
      const srcRom = typeof source?.romOff === 'number' ? `@$${fmtHex(source.romOff, 6)}` : '';
      const srcMnemonic = source?.mnemonic || 'unknown';
      const effect = source?.effect ? `/${source.effect}` : '';
      const subject = source?.subject?.reg ? ` ${source.subject.reg}` : '';
      const flag = branch.flag || '?';
      const takenWhen = branch.takenWhen === 0 || branch.takenWhen === 1 ? `=${branch.takenWhen}` : '';
      return { kind: 'branchFlagUse', text: `branchFlagUse ${branch.mnemonic || '?'} reads ${flag}${takenWhen} from ${srcMnemonic}${effect}${subject}${srcRom}`, details };
    }
    default:
      return { kind: obs?.kind || 'unknown', text: String(obs?.kind || 'unknown'), details };
  }
}

function buildObservationIndex(observations) {
  const byRawBlockId = new Map();
  const byRomOff = new Map();
  for (const obs of Array.isArray(observations) ? observations : []) {
    const atRomOff = typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null;
    const rawBlockId = typeof obs?.rawBlockId === 'string' && obs.rawBlockId ? obs.rawBlockId : null;
    if (rawBlockId) {
      if (!byRawBlockId.has(rawBlockId)) byRawBlockId.set(rawBlockId, []);
      byRawBlockId.get(rawBlockId).push(obs);
    }
    if (atRomOff !== null) {
      if (!byRomOff.has(atRomOff)) byRomOff.set(atRomOff, []);
      byRomOff.get(atRomOff).push(obs);
    }
  }
  return { byRawBlockId, byRomOff };
}

export function buildVsaLineDebugForBlock({ block, observationsResult }) {
  if (!block || typeof block !== 'object') return null;
  const lines = Array.isArray(block.lines) ? block.lines : [];
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const { byRawBlockId, byRomOff } = buildObservationIndex(observations);
  const rawMemberIds = new Set((Array.isArray(block.rawBlockIds) ? block.rawBlockIds : []).filter(Boolean));
  const lineOffsets = new Set(lines.map((line) => (typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null)).filter((n) => n !== null));
  const selected = new Map();

  function addObservation(obs) {
    const atRomOff = typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null;
    if (atRomOff === null || !lineOffsets.has(atRomOff)) return;
    if (!selected.has(atRomOff)) selected.set(atRomOff, new Map());
    const id = typeof obs?.id === 'string' && obs.id ? obs.id : `${obs?.kind || 'obs'}:${atRomOff}:${selected.get(atRomOff).size}`;
    selected.get(atRomOff).set(id, obs);
  }

  for (const rawBlockId of rawMemberIds) {
    for (const obs of byRawBlockId.get(rawBlockId) || []) addObservation(obs);
  }
  for (const romOff of lineOffsets) {
    for (const obs of byRomOff.get(romOff) || []) {
      if (obs?.rawBlockId && !rawMemberIds.has(obs.rawBlockId)) continue;
      addObservation(obs);
    }
  }

  const debugLines = lines.map((line) => {
    const romOff = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
    const obsList = romOff !== null ? Array.from((selected.get(romOff) || new Map()).values()) : [];
    obsList.sort((a, b) => String(a?.kind || '').localeCompare(String(b?.kind || '')) || String(a?.id || '').localeCompare(String(b?.id || '')));
    return {
      romOff,
      romEnd: lineEnd(line),
      cpuAddr: typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
      bytesText: typeof line?.bytesText === 'string' ? line.bytesText : '',
      asm: typeof line?.asm === 'string' ? line.asm : '',
      entries: obsList.map((obs) => ({
        id: obs.id || null,
        atRomOff: typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
        ...formatObservation(obs),
        raw: obs
      }))
    };
  });

  const observationCount = debugLines.reduce((sum, line) => sum + line.entries.length, 0);
  return {
    displayBlockId: block.id || null,
    romStart: typeof block.romStart === 'number' ? (block.romStart >>> 0) : null,
    romEnd: typeof block.romEnd === 'number' ? (block.romEnd >>> 0) : null,
    cpuStart: typeof block.cpuStart === 'number' ? (block.cpuStart & 0xffff) : null,
    lineCount: debugLines.length,
    observationCount,
    lines: debugLines
  };
}
