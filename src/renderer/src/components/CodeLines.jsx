import { fmtHex } from '../../../shared/utils/hexUtils.js';
import { parseBytesText } from '../../../shared/utils/byteTextUtils.js';
import { u16le } from '../../../shared/utils/binaryReadUtils.js';

function getAddrLabel(labelsByAddr, addr) {
  if (!labelsByAddr || typeof labelsByAddr !== 'object') return '';
  const v = labelsByAddr[String(addr & 0xffff)];
  return typeof v === 'string' ? v : '';
}

function fmtZpOrLabel(labelsByAddr, zpAddr) {
  const a = zpAddr & 0xff;
  const lbl = getAddrLabel(labelsByAddr, a);
  return lbl || `$${fmtHex(a, 2)}`;
}

function fmtAbsOrLabel(labelsByAddr, absAddr) {
  const a = absAddr & 0xffff;
  const lbl = getAddrLabel(labelsByAddr, a);
  return lbl || `$${fmtHex(a, 4)}`;
}

function buildOperandDisplay(line, labelsByAddr) {
  const mode = line?.mode;
  const mnemonic = line?.mnemonic;
  const bytes = parseBytesText(line?.bytesText, { strict: false });

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
      return { operandText: `#$${fmtHex(imm, 2)}`, operandAddr: null };
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

export function buildAsmText(line, labelsByAddr) {
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

function getSelectedCodeText(lineEl) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return '';

  const root = lineEl?.closest?.('.nv-code-lines');
  if (!root) return '';

  const range = selection.getRangeAt(0);
  const rows = Array.from(root.querySelectorAll('.nv-line[data-asm-text]'));
  const asmLines = [];
  for (const row of rows) {
    if (!range.intersectsNode(row)) continue;
    const asmText = row.getAttribute('data-asm-text') || '';
    if (asmText) asmLines.push(asmText);
  }
  return asmLines.join('\n');
}

export function CodeLines({
  lines,
  currentBlockId,
  labelsByRomOff,
  labelsByAddr,
  onNavigateToRomOff,
  onHoverLine,
  onContextMenuLine,
  markedRomSpan
}) {
  if (!lines || lines.length === 0) return null;

  const spanStart = typeof markedRomSpan?.start === 'number' ? (markedRomSpan.start >>> 0) : null;
  const spanEnd = typeof markedRomSpan?.end === 'number' ? (markedRomSpan.end >>> 0) : null;
  const hasMarkedSpan = spanStart !== null && spanEnd !== null && spanEnd > spanStart;

  return (
    <div className="nv-code-lines">
      {lines.map((line, index) => {
        const lineRomOff = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
        const lineLen = typeof line?.len === 'number' && line.len > 0 ? (line.len >>> 0) : 1;
        const lineEnd = lineRomOff !== null ? lineRomOff + lineLen : null;
        const lineLabel = (lineRomOff !== null && labelsByRomOff && typeof labelsByRomOff === 'object')
          ? (labelsByRomOff[String(lineRomOff)]?.label || '')
          : '';

        const asmText = buildAsmText(line, labelsByAddr);

        const flowType = line?.flow?.type;
        const isDirect = flowType === 'branch' || flowType === 'jump' || flowType === 'call';
        const targetRomOff = isDirect && typeof line.flow?.targetRomOff === 'number'
          ? (line.flow.targetRomOff >>> 0)
          : null;
        const target = isDirect && typeof line.flow?.target === 'number' ? (line.flow.target & 0xffff) : null;
        const canNav = targetRomOff !== null;
        const targetLabel = (typeof target === 'number') ? getAddrLabel(labelsByAddr, target & 0xffff) : '';
        const linkTitle = targetRomOff !== null
          ? (targetLabel ? `Go to ${targetLabel} (ROM ${fmtHex(targetRomOff, 6)})` : `Go to ROM ${fmtHex(targetRomOff, 6)}`)
          : '';

        const isMarked = hasMarkedSpan
          && lineRomOff !== null
          && lineEnd !== null
          && lineRomOff < spanEnd
          && lineEnd > spanStart;

        return (
          <div
            key={lineRomOff !== null ? `rom:${lineRomOff}` : `line:${index}`}
            className={`nv-line ${isMarked ? 'is-poi-marked' : ''}`}
            data-asm-text={asmText}
            data-rom-off={lineRomOff !== null ? String(lineRomOff) : undefined}
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
                operandAddr: operandAddrForMenu,
                asmText,
                selectedCodeText: getSelectedCodeText(e.currentTarget)
              }, e.clientX, e.clientY);
            }}
          >
            <div className="nv-col-romoff">{fmtHex(line.romOff, 6)}</div>
            <div className="nv-col-cpu">${fmtHex(line.cpuAddr, 4)}</div>
            <div className="nv-col-bytes">{line.bytesText}</div>
            <div className="nv-col-label">{lineLabel}</div>
            <div className="nv-col-asm">
              {canNav ? (
                <button
                  type="button"
                  className="nv-asm-link"
                  onClick={() => onNavigateToRomOff?.(targetRomOff)}
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
