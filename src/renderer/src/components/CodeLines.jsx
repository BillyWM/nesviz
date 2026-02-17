import { hex4, hex6 } from '../util/hex.js';

function hex2(n) {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function parseBytesText(bytesText) {
  if (typeof bytesText !== 'string') return [];
  const parts = bytesText.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const v = parseInt(p, 16);
    if (Number.isFinite(v)) out.push(v & 0xff);
  }
  return out;
}

function u16le(bytes, off) {
  const lo = bytes[off] ?? 0;
  const hi = bytes[off + 1] ?? 0;
  return (lo | (hi << 8)) & 0xffff;
}

function getAddrLabel(labelsByAddr, addr) {
  if (!labelsByAddr || typeof labelsByAddr !== 'object') return '';
  const v = labelsByAddr[String(addr & 0xffff)];
  return typeof v === 'string' ? v : '';
}

function fmtZpOrLabel(labelsByAddr, zpAddr) {
  const a = zpAddr & 0xff;
  const lbl = getAddrLabel(labelsByAddr, a);
  return lbl || `$${hex2(a)}`;
}

function fmtAbsOrLabel(labelsByAddr, absAddr) {
  const a = absAddr & 0xffff;
  const lbl = getAddrLabel(labelsByAddr, a);
  return lbl || `$${hex4(a)}`;
}

function buildOperandDisplay(line, labelsByAddr) {
  const mode = line?.mode;
  const mnemonic = line?.mnemonic;
  const bytes = parseBytesText(line?.bytesText);

  // Prefer the discovered CFG target for control-flow instructions.
  const flow = line?.flow;
  const isDirectFlow = flow && (flow.type === 'branch' || flow.type === 'jump' || flow.type === 'call');
  const flowTarget = (isDirectFlow && typeof flow?.target === 'number') ? (flow.target & 0xffff) : null;

  // Helper to build a base address (and its label) without decorations.
  function baseAbs(addr) {
    return { text: fmtAbsOrLabel(labelsByAddr, addr), addr: addr & 0xffff };
  }

  function baseZp(addr) {
    return { text: fmtZpOrLabel(labelsByAddr, addr), addr: addr & 0xff };
  }

  // Some lines may not have structured decode fields yet (or at all). Fall back to raw asm.
  if (typeof mnemonic !== 'string' || !mnemonic) {
    return { operandText: null, operandAddr: null };
  }

  switch (mode) {
    case 'imp':
      return { operandText: '', operandAddr: null };

    case 'acc':
      return { operandText: 'A', operandAddr: null };

    case 'imm': {
      const imm = bytes.length >= 2 ? (bytes[1] & 0xff) : null;
      if (imm == null) return { operandText: '', operandAddr: null };
      return { operandText: `#$${hex2(imm)}`, operandAddr: null };
    }

    case 'rel': {
      if (flowTarget == null) return { operandText: '', operandAddr: null };
      return { operandText: fmtAbsOrLabel(labelsByAddr, flowTarget), operandAddr: flowTarget };
    }

    case 'zp': {
      const zp = bytes.length >= 2 ? (bytes[1] & 0xff) : null;
      if (zp == null) return { operandText: '', operandAddr: null };
      const b = baseZp(zp);
      return { operandText: b.text, operandAddr: b.addr };
    }

    case 'zpX': {
      const zp = bytes.length >= 2 ? (bytes[1] & 0xff) : null;
      if (zp == null) return { operandText: '', operandAddr: null };
      const b = baseZp(zp);
      return { operandText: `${b.text},X`, operandAddr: b.addr };
    }

    case 'zpY': {
      const zp = bytes.length >= 2 ? (bytes[1] & 0xff) : null;
      if (zp == null) return { operandText: '', operandAddr: null };
      const b = baseZp(zp);
      return { operandText: `${b.text},Y`, operandAddr: b.addr };
    }

    case 'abs': {
      // For JSR/JMP we can rely on the CFG target if present.
      const abs = (flowTarget != null && (mnemonic === 'JSR' || mnemonic === 'JMP'))
        ? flowTarget
        : (bytes.length >= 3 ? u16le(bytes, 1) : null);
      if (abs == null) return { operandText: '', operandAddr: null };
      const b = baseAbs(abs);
      return { operandText: b.text, operandAddr: b.addr };
    }

    case 'absX': {
      const abs = bytes.length >= 3 ? u16le(bytes, 1) : null;
      if (abs == null) return { operandText: '', operandAddr: null };
      const b = baseAbs(abs);
      return { operandText: `${b.text},X`, operandAddr: b.addr };
    }

    case 'absY': {
      const abs = bytes.length >= 3 ? u16le(bytes, 1) : null;
      if (abs == null) return { operandText: '', operandAddr: null };
      const b = baseAbs(abs);
      return { operandText: `${b.text},Y`, operandAddr: b.addr };
    }

    case 'ind': {
      const abs = bytes.length >= 3 ? u16le(bytes, 1) : null;
      if (abs == null) return { operandText: '', operandAddr: null };
      const b = baseAbs(abs);
      return { operandText: `(${b.text})`, operandAddr: b.addr };
    }

    case 'indX': {
      const zp = bytes.length >= 2 ? (bytes[1] & 0xff) : null;
      if (zp == null) return { operandText: '', operandAddr: null };
      const b = baseZp(zp);
      return { operandText: `(${b.text},X)`, operandAddr: b.addr };
    }

    case 'indY': {
      const zp = bytes.length >= 2 ? (bytes[1] & 0xff) : null;
      if (zp == null) return { operandText: '', operandAddr: null };
      const b = baseZp(zp);
      return { operandText: `(${b.text}),Y`, operandAddr: b.addr };
    }

    default:
      return { operandText: null, operandAddr: null };
  }
}

function buildAsmText(line, labelsByAddr) {
  const mnemonic = typeof line?.mnemonic === 'string' ? line.mnemonic : '';
  if (!mnemonic) return typeof line?.asm === 'string' ? line.asm : '';

  const { operandText } = buildOperandDisplay(line, labelsByAddr);
  if (operandText === null) return typeof line?.asm === 'string' ? line.asm : mnemonic;
  if (!operandText) return mnemonic;
  return `${mnemonic} ${operandText}`;
}

function getOperandAddrForMenu(line) {
  const flow = line?.flow;
  const isDirectFlow = flow && (flow.type === 'branch' || flow.type === 'jump' || flow.type === 'call');
  if (isDirectFlow && typeof flow?.target === 'number') return flow.target & 0xffff;

  const { operandAddr } = buildOperandDisplay(line, null);
  return (typeof operandAddr === 'number') ? (operandAddr & 0xffff) : null;
}

export function CodeLines({
  lines,
  currentBlockId,
  ctxId = 'nrom',
  labelsByRomOff,
  labelsByAddr,
  onNavigateToCpuAddr,
  canNavigateCpuAddr,
  resolveBlockIdForCpuAddr,
  onHoverLine,
  onContextMenuLine,
  markedPoiSpan
}) {
  if (!lines || lines.length === 0) return null;

  const poiStart = typeof markedPoiSpan?.start === 'number' ? (markedPoiSpan.start >>> 0) : null;
  const poiEnd = typeof markedPoiSpan?.end === 'number' ? (markedPoiSpan.end >>> 0) : null;
  const hasPoi = poiStart !== null && poiEnd !== null && poiEnd > poiStart;

  return (
    <div className="nv-code-lines">
      {lines.map((line) => {
        const lineLabel = (typeof line?.romOff === 'number' && labelsByRomOff && typeof labelsByRomOff === 'object')
          ? (labelsByRomOff[String(line.romOff | 0)] || '')
          : '';

        const asmText = buildAsmText(line, labelsByAddr);

        const flowType = line?.flow?.type;
        const isDirect = flowType === 'branch' || flowType === 'jump' || flowType === 'call';
        const target = isDirect ? line.flow?.target : null;
        const resolvedTargetBlockId = typeof target === 'number' && typeof resolveBlockIdForCpuAddr === 'function'
          ? resolveBlockIdForCpuAddr(target, ctxId)
          : null;

        // Avoid intra-block navigation (loops, short forward skips, etc.) once we coalesce blocks.
        // We only link when we can resolve the target to a *different* decoded block.
        const canNav = typeof target === 'number'
          ? (resolvedTargetBlockId ? (resolvedTargetBlockId !== currentBlockId) : (typeof canNavigateCpuAddr === 'function' && canNavigateCpuAddr(target, ctxId)))
          : false;

        const targetLabel = (typeof target === 'number') ? getAddrLabel(labelsByAddr, target & 0xffff) : '';
        const linkTitle = typeof target === 'number'
          ? (targetLabel ? `Go to ${targetLabel} ($${hex4(target)})` : `Go to $${hex4(target)}`)
          : '';

        return (
          <div
            key={`${line.romOff}:${line.cpuAddr}`}
            className={`nv-line ${hasPoi && (line.romOff >>> 0) >= poiStart && (line.romOff >>> 0) < poiEnd ? 'is-poi-marked' : ''}`}
            onMouseEnter={() => {
              if (typeof onHoverLine === 'function') {
                onHoverLine({ romOff: line.romOff, cpuAddr: line.cpuAddr, blockId: currentBlockId });
              }
            }}
            onContextMenu={(e) => {
              if (typeof onContextMenuLine !== 'function') return;
              e.preventDefault();
              e.stopPropagation();
              const isAsm = !!e.target?.closest?.('.nv-col-asm');
              const operandAddrForMenu = isAsm ? getOperandAddrForMenu(line) : null;
              onContextMenuLine({
                romOff: line.romOff,
                cpuAddr: line.cpuAddr,
                blockId: currentBlockId,
                labelTarget: isAsm ? 'operand' : 'line',
                operandAddr: operandAddrForMenu
              }, e.clientX, e.clientY);
            }}
          >
            <div className="nv-col-romoff">{hex6(line.romOff)}</div>
            <div className="nv-col-cpu">${hex4(line.cpuAddr)}</div>
            <div className="nv-col-bytes">{line.bytesText}</div>
            <div className="nv-col-label">{lineLabel}</div>
            <div className="nv-col-asm">
              {canNav ? (
                <button
                  type="button"
                  className="nv-asm-link"
                  onClick={() => onNavigateToCpuAddr?.(target, ctxId)}
                  title={linkTitle}
                >
                  {asmText}
                </button>
              ) : (
                asmText
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
