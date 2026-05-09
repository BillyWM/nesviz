import { getVsaBlockIds } from './blockIdentity.js';
import { uniqueSortedStrings } from '../../utils/uniqueUtils.js';

function observationsByRawBlockId(observations) {
  const out = new Map();
  for (const obs of observations || []) {
    const rawBlockId = typeof obs?.rawBlockId === 'string' && obs.rawBlockId ? obs.rawBlockId : null;
    if (!rawBlockId) continue;
    if (!out.has(rawBlockId)) out.set(rawBlockId, []);
    out.get(rawBlockId).push(obs);
  }
  return out;
}

function lineIndexByRomOff(block) {
  const out = new Map();
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  for (let i = 0; i < lines.length; i++) {
    const romOff = typeof lines[i]?.romOff === 'number' ? (lines[i].romOff >>> 0) : null;
    if (romOff !== null && !out.has(romOff)) out.set(romOff, i);
  }
  return out;
}

function branchObservationsForBlock(block, observationsByRaw) {
  const out = [];
  for (const rawBlockId of getVsaBlockIds(block)) {
    for (const obs of observationsByRaw.get(rawBlockId) || []) {
      if (obs?.kind === 'branchFlagUse') out.push(obs);
    }
  }
  return out;
}

function branchLineForObservation(block, obs) {
  const branchRomOff = typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null;
  if (branchRomOff === null) return null;
  for (const line of Array.isArray(block?.lines) ? block.lines : []) {
    if (typeof line?.romOff === 'number' && (line.romOff >>> 0) === branchRomOff) return line;
  }
  return null;
}

function branchTargetRomOff(line, obs) {
  if (typeof line?.flow?.targetRomOff === 'number') return line.flow.targetRomOff >>> 0;
  if (typeof obs?.branch?.targetRomOff === 'number') return obs.branch.targetRomOff >>> 0;
  return null;
}

function branchFallthroughRomOff(line, obs) {
  if (typeof line?.flow?.fallthroughRomOff === 'number') return line.flow.fallthroughRomOff >>> 0;
  if (typeof obs?.branch?.fallthroughRomOff === 'number') return obs.branch.fallthroughRomOff >>> 0;
  return null;
}

function sourceRomOff(obs) {
  return typeof obs?.source?.romOff === 'number' ? (obs.source.romOff >>> 0) : null;
}

function controllerForBranchSource(source) {
  const mnemonic = source?.mnemonic || null;
  const effect = source?.effect || null;
  const subject = source?.subject || null;
  const reg = subject?.reg || null;

  if ((reg === 'X' || reg === 'Y') && ['INX', 'DEX', 'INY', 'DEY'].includes(mnemonic)) {
    return {
      guideKind: 'index',
      controller: {
        kind: 'reg',
        reg,
        sourceMnemonic: mnemonic,
        sourceEffect: effect
      }
    };
  }

  if (subject?.kind === 'compare' && (subject.reg === 'X' || subject.reg === 'Y') && (mnemonic === 'CPX' || mnemonic === 'CPY')) {
    return {
      guideKind: 'index',
      controller: {
        kind: 'compare',
        reg: subject.reg,
        sourceMnemonic: mnemonic,
        sourceEffect: effect,
        imm: typeof subject.imm === 'number' ? (subject.imm & 0xff) : null
      }
    };
  }

  return {
    guideKind: 'flag',
    controller: {
      kind: 'flagSource',
      reg: typeof reg === 'string' ? reg : null,
      sourceMnemonic: mnemonic,
      sourceEffect: effect,
      subject: subject && typeof subject === 'object' ? { ...subject } : null
    }
  };
}

function makeGuideId(displayBlockId, guideKind, targetRomOff, branchRomOff, sourceRomOffValue) {
  const src = typeof sourceRomOffValue === 'number' ? sourceRomOffValue.toString(16).padStart(6, '0') : 'nosrc';
  return `loopGuide:${displayBlockId}:${guideKind}:${targetRomOff.toString(16).padStart(6, '0')}-${branchRomOff.toString(16).padStart(6, '0')}:${src}`;
}

function buildGuidesForBlock(block, observationsByRaw) {
  const lineIndex = lineIndexByRomOff(block);
  const guides = [];
  const seen = new Set();

  for (const obs of branchObservationsForBlock(block, observationsByRaw)) {
    const branchLine = branchLineForObservation(block, obs);
    if (!branchLine) continue;
    if (branchLine?.flow?.type !== 'branch') continue;

    const branchRomOff = typeof branchLine.romOff === 'number' ? (branchLine.romOff >>> 0) : null;
    const targetRomOff = branchTargetRomOff(branchLine, obs);
    if (branchRomOff === null || targetRomOff === null) continue;
    if (targetRomOff >= branchRomOff) continue;
    if (!lineIndex.has(targetRomOff) || !lineIndex.has(branchRomOff)) continue;

    const srcRomOff = sourceRomOff(obs);
    if (srcRomOff === null) continue;
    if (srcRomOff < targetRomOff || srcRomOff > branchRomOff) continue;
    if (!obs.source) continue;

    const { guideKind, controller } = controllerForBranchSource(obs.source);
    const id = makeGuideId(block.id, guideKind, targetRomOff, branchRomOff, srcRomOff);
    if (seen.has(id)) continue;
    seen.add(id);

    guides.push({
      id,
      kind: 'loopGuide',
      guideKind,
      range: {
        startRomOff: targetRomOff,
        endRomOff: branchRomOff
      },
      anchors: {
        targetRomOff,
        branchRomOff,
        sourceRomOff: srcRomOff
      },
      branch: {
        mnemonic: obs.branch?.mnemonic || branchLine.mnemonic || null,
        flag: obs.branch?.flag || null,
        takenWhen: obs.branch?.takenWhen === 0 || obs.branch?.takenWhen === 1 ? obs.branch.takenWhen : null,
        targetRomOff,
        fallthroughRomOff: branchFallthroughRomOff(branchLine, obs),
        targetCpuAddr: typeof branchLine?.flow?.target === 'number' ? (branchLine.flow.target & 0xffff) : (typeof obs.branch?.targetCpuAddr === 'number' ? (obs.branch.targetCpuAddr & 0xffff) : null),
        fallthroughCpuAddr: typeof branchLine?.flow?.fallthrough === 'number' ? (branchLine.flow.fallthrough & 0xffff) : (typeof obs.branch?.fallthroughCpuAddr === 'number' ? (obs.branch.fallthroughCpuAddr & 0xffff) : null)
      },
      controller,
      rawBlockIds: uniqueSortedStrings([obs.rawBlockId, ...(Array.isArray(block.rawBlockIds) ? block.rawBlockIds : [])].filter(Boolean))
    });
  }

  guides.sort((a, b) => {
    if (a.range.startRomOff !== b.range.startRomOff) return a.range.startRomOff - b.range.startRomOff;
    if (a.range.endRomOff !== b.range.endRomOff) return b.range.endRomOff - a.range.endRomOff;
    if (a.guideKind !== b.guideKind) return String(a.guideKind).localeCompare(String(b.guideKind));
    return String(a.id).localeCompare(String(b.id));
  });

  return guides;
}

export function buildLoopGuides({ displayBlocks, observationsResult } = {}) {
  const blocks = Array.isArray(displayBlocks) ? displayBlocks : [];
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const byRaw = observationsByRawBlockId(observations);

  for (const block of blocks) {
    const guides = buildGuidesForBlock(block, byRaw);
    if (guides.length) block.loopGuides = guides;
    else if (block && Object.prototype.hasOwnProperty.call(block, 'loopGuides')) delete block.loopGuides;
  }

  return blocks;
}
