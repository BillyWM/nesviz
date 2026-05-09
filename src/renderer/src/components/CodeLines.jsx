import { fmtHex } from '../../../shared/utils/numberUtils.js';
import { parseBytesText } from '../../../shared/utils/byteUtils.js';
import { u16le } from '../../../shared/utils/byteUtils.js';
import { getNamedRegisterName } from '../../../shared/nes/namedRegisters.js';

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

function fmtAbsOrLabel(labelsByAddr, absAddr, options = null) {
  const a = absAddr & 0xffff;
  const lbl = getAddrLabel(labelsByAddr, a);
  if (lbl) return lbl;
  const named = options?.showNamedConstants !== false ? getNamedRegisterName(a, { space: 'cpu' }) : '';
  return named || `$${fmtHex(a, 4)}`;
}

function buildOperandDisplay(line, labelsByAddr, options = null) {
  const mode = line?.mode;
  const mnemonic = line?.mnemonic;
  const bytes = parseBytesText(line?.bytesText, { strict: false });

  // Prefer the discovered CFG target for control-flow instructions.
  const flow = line?.flow;
  const isDirectFlow = flow && (flow.type === 'branch' || flow.type === 'jump' || flow.type === 'call');
  const flowTarget = (isDirectFlow && typeof flow?.target === 'number') ? (flow.target & 0xffff) : null;

  // Helper to build a base address (and its label) without decorations.
  function baseAbs(addr) {
    return { text: fmtAbsOrLabel(labelsByAddr, addr, options), addr: addr & 0xffff };
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
      return { operandText: fmtAbsOrLabel(labelsByAddr, flowTarget, { showNamedConstants: false }), operandAddr: flowTarget };
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
      // For JSR/JMP we can rely on the CFG target if present. These are code
      // destinations, so keep named hardware constants out of control-flow text.
      const isAbsFlow = mnemonic === 'JSR' || mnemonic === 'JMP';
      const abs = (flowTarget != null && isAbsFlow)
        ? flowTarget
        : (bytes.length >= 3 ? u16le(bytes, 1) : null);
      if (abs == null) return { operandText: '', operandAddr: null };
      const b = isAbsFlow
        ? { text: fmtAbsOrLabel(labelsByAddr, abs, { showNamedConstants: false }), addr: abs & 0xffff }
        : baseAbs(abs);
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

export function buildAsmText(line, labelsByAddr, options = null) {
  const mnemonic = typeof line?.mnemonic === 'string' ? line.mnemonic : '';
  if (!mnemonic) return typeof line?.asm === 'string' ? line.asm : '';

  const { operandText } = buildOperandDisplay(line, labelsByAddr, options);
  if (operandText === null) return typeof line?.asm === 'string' ? line.asm : mnemonic;
  if (!operandText) return mnemonic;
  return `${mnemonic} ${operandText}`;
}

function getOperandAddrForMenu(line) {
  const flow = line?.flow;
  const isDirectFlow = flow && (flow.type === 'branch' || flow.type === 'jump' || flow.type === 'call');
  if (isDirectFlow && typeof flow?.target === 'number') return flow.target & 0xffff;

  const { operandAddr } = buildOperandDisplay(line, null, { showNamedConstants: false });
  return (typeof operandAddr === 'number') ? (operandAddr & 0xffff) : null;
}

function getSelectedCodeText(lineEl) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return '';

  const root = lineEl?.closest('.nv-code-lines');
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


const MAX_LOOP_GUIDE_LANES = 4;

function buildLineIndexByRomOff(lines) {
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const romOff = typeof lines[i]?.romOff === 'number' ? (lines[i].romOff >>> 0) : null;
    if (romOff !== null && !out.has(romOff)) out.set(romOff, i);
  }
  return out;
}

function buildLoopGuideRows(lines, loopGuides) {
  const rows = Array.from({ length: lines.length }, () => []);
  if (!Array.isArray(loopGuides) || loopGuides.length === 0) return rows;

  const lineIndex = buildLineIndexByRomOff(lines);
  const candidates = [];

  for (const guide of loopGuides) {
    if (!guide || guide.kind !== 'loopGuide') continue;
    const startRomOff = typeof guide.range?.startRomOff === 'number'
      ? (guide.range.startRomOff >>> 0)
      : (typeof guide.anchors?.targetRomOff === 'number' ? (guide.anchors.targetRomOff >>> 0) : null);
    const endRomOff = typeof guide.range?.endRomOff === 'number'
      ? (guide.range.endRomOff >>> 0)
      : (typeof guide.anchors?.branchRomOff === 'number' ? (guide.anchors.branchRomOff >>> 0) : null);
    if (startRomOff === null || endRomOff === null) continue;

    const startIndex = lineIndex.get(startRomOff);
    const endIndex = lineIndex.get(endRomOff);
    if (typeof startIndex !== 'number' || typeof endIndex !== 'number') continue;
    if (endIndex <= startIndex) continue;

    candidates.push({
      guide,
      startIndex,
      endIndex,
      span: endIndex - startIndex
    });
  }

  candidates.sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
    if (a.endIndex !== b.endIndex) return b.endIndex - a.endIndex;
    if (a.guide?.guideKind !== b.guide?.guideKind) return String(a.guide?.guideKind).localeCompare(String(b.guide?.guideKind));
    return String(a.guide?.id || '').localeCompare(String(b.guide?.id || ''));
  });

  const laneEndIndexes = [];
  for (const candidate of candidates) {
    let lane = -1;
    for (let i = 0; i < MAX_LOOP_GUIDE_LANES; i++) {
      const laneEnd = typeof laneEndIndexes[i] === 'number' ? laneEndIndexes[i] : -1;
      if (laneEnd < candidate.startIndex) {
        lane = i;
        break;
      }
    }
    if (lane < 0) continue;
    laneEndIndexes[lane] = candidate.endIndex;

    for (let i = candidate.startIndex; i <= candidate.endIndex; i++) {
      rows[i].push({
        id: candidate.guide?.id || `loop:${lane}:${candidate.startIndex}:${candidate.endIndex}`,
        lane,
        guideKind: candidate.guide?.guideKind || 'flag',
        isStart: i === candidate.startIndex,
        isEnd: i === candidate.endIndex
      });
    }
  }

  for (const row of rows) row.sort((a, b) => a.lane - b.lane);
  return rows;
}

function LoopGuideGutter({ segments }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return <div className="nv-loop-guide-gutter" aria-hidden="true" />;
  }

  return (
    <div className="nv-loop-guide-gutter" aria-hidden="true">
      {segments.map((segment) => {
        const className = [
          'nv-loop-guide-segment',
          `is-lane-${segment.lane}`,
          segment.guideKind === 'index' ? 'is-index-loop' : 'is-flag-loop',
          segment.isStart ? 'is-start' : '',
          segment.isEnd ? 'is-end' : '',
          !segment.isStart && !segment.isEnd ? 'is-middle' : ''
        ].filter(Boolean).join(' ');
        return <span key={`${segment.id}:${segment.lane}:${segment.isStart ? 'start' : segment.isEnd ? 'end' : 'mid'}`} className={className} />;
      })}
    </div>
  );
}

export function CodeLines({
  lines,
  currentBlockId,
  labelsByRomOff,
  labelsByAddr,
  onNavigateToRomOff,
  onHoverLine,
  onContextMenuLine,
  markedRomSpan,
  loopGuides,
  showDebugInfo = false,
  showNamedConstants = true
}) {
  if (!lines || lines.length === 0) return null;

  const spanStart = typeof markedRomSpan?.start === 'number' ? (markedRomSpan.start >>> 0) : null;
  const spanEnd = typeof markedRomSpan?.end === 'number' ? (markedRomSpan.end >>> 0) : null;
  const hasMarkedSpan = spanStart !== null && spanEnd !== null && spanEnd > spanStart;
  const loopGuideRows = buildLoopGuideRows(lines, loopGuides);

  return (
    <div className="nv-code-lines">
      {lines.map((line, index) => {
        const lineRomOff = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
        const lineLen = typeof line?.len === 'number' && line.len > 0 ? (line.len >>> 0) : 1;
        const lineEnd = lineRomOff !== null ? lineRomOff + lineLen : null;
        const lineLabel = (lineRomOff !== null && labelsByRomOff && typeof labelsByRomOff === 'object')
          ? (labelsByRomOff[String(lineRomOff)]?.label || '')
          : '';

        const asmText = buildAsmText(line, labelsByAddr, { showNamedConstants });

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
        const lineConfidence = line?.confidence === 'probable' ? 'probable' : 'certain';
        const isRawCfgBlockEnd = showDebugInfo && line?.rawCfgBlockEnd === true;
        const rawCfgBlockEndKind = line?.rawCfgBlockEndKind === 'probable' ? 'probable' : 'certain';
        const lineClassName = [
          'nv-line',
          isMarked ? 'is-poi-marked' : '',
          isRawCfgBlockEnd ? 'is-raw-cfg-block-end' : '',
          isRawCfgBlockEnd ? `is-raw-cfg-block-end-${rawCfgBlockEndKind}` : ''
        ].filter(Boolean).join(' ');

        return (
          <div
            key={lineRomOff !== null ? `rom:${lineRomOff}` : `line:${index}`}
            className={lineClassName}
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
              const isAsm = !!e.target?.closest('.nv-col-asm');
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
            <div className={`nv-confidence-rail-segment is-${lineConfidence}`} aria-hidden="true" />
            <div className="nv-col-romoff">{fmtHex(line.romOff, 6)}</div>
            <div className="nv-col-cpu">${fmtHex(line.cpuAddr, 4)}</div>
            <div className="nv-col-bytes">{line.bytesText}</div>
            <div className="nv-col-label">{lineLabel}</div>
            <div className="nv-col-asm">
              <LoopGuideGutter segments={loopGuideRows[index]} />
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
