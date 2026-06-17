import {
  requireArray,
  requireDisplayBlock,
  requireDisplayLine,
  requireInteger,
  requireObject,
  requireString
} from '../../shared/analyze/dataShape.js';

export function requireCodeViewState(active) {
  if (!active || !active.displayAnalysis) return null;
  if (!active.blockById) throw new Error('Analysis block index is missing');
  const displayAnalysis = requireObject(active.displayAnalysis, 'displayAnalysis');
  requireArray(displayAnalysis.blocks, 'displayAnalysis.blocks');
  return {
    active,
    displayAnalysis,
    blockById: active.blockById,
    ines: active.ines || null
  };
}

export function serializeFlowForRenderer(flow) {
  requireObject(flow, 'display line flow');
  const out = { type: requireString(flow.type, 'display line flow.type') };
  if (typeof flow.target === 'number') out.target = flow.target & 0xffff;
  if (typeof flow.fallthrough === 'number') out.fallthrough = flow.fallthrough & 0xffff;
  if (typeof flow.next === 'number') out.next = flow.next & 0xffff;
  if (typeof flow.ptrAddr === 'number') out.ptrAddr = flow.ptrAddr & 0xffff;
  if (typeof flow.targetRomOff === 'number') out.targetRomOff = flow.targetRomOff >>> 0;
  if (typeof flow.fallthroughRomOff === 'number') out.fallthroughRomOff = flow.fallthroughRomOff >>> 0;
  if (typeof flow.nextRomOff === 'number') out.nextRomOff = flow.nextRomOff >>> 0;
  return out;
}

function serializeDeadCodeForRenderer(deadCode) {
  if (!deadCode || typeof deadCode !== 'object' || Array.isArray(deadCode)) return null;
  const reasons = Array.isArray(deadCode.reasons)
    ? Array.from(new Set(deadCode.reasons.filter((reason) => typeof reason === 'string' && reason)))
    : [];
  if (!reasons.length) return null;
  return { reasons };
}

export function serializeLineForRenderer(line) {
  requireDisplayLine(line, 'display line');
  const cpuAddrCandidates = Array.isArray(line.cpuAddrCandidates)
    ? Array.from(new Set(line.cpuAddrCandidates
      .filter((addr) => Number.isInteger(addr))
      .map((addr) => addr & 0xffff)))
      .sort((a, b) => a - b)
    : [];
  return {
    backing: line.backing,
    romOff: line.romOff >>> 0,
    cpuAddr: typeof line.cpuAddr === 'number' ? line.cpuAddr & 0xffff : null,
    cpuAddrCandidates,
    len: line.len >>> 0,
    bytesText: line.bytesText,
    asm: line.asm,
    mnemonic: line.mnemonic,
    mode: line.mode,
    flow: serializeFlowForRenderer(line.flow),
    deadCode: serializeDeadCodeForRenderer(line.deadCode)
  };
}

export function serializeCodeBlock(block) {
  requireDisplayBlock(block, 'display block');
  return {
    ...block,
    lines: block.lines.map(serializeLineForRenderer)
  };
}

export function buildInboundRefsByBlockId(displayAnalysis) {
  requireObject(displayAnalysis, 'display analysis');
  const blocks = requireArray(displayAnalysis.blocks, 'displayAnalysis.blocks');
  const romOffToBlockId = new Map();
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = requireDisplayBlock(blocks[blockIndex], `displayAnalysis.blocks[${blockIndex}]`);
    for (const line of block.lines) {
      romOffToBlockId.set(line.romOff >>> 0, block.id);
    }
  }

  const inbound = new Map();
  for (const fromBlock of blocks) {
    requireDisplayBlock(fromBlock, 'displayAnalysis block');
    for (const line of fromBlock.lines) {
      const flow = requireObject(line.flow, 'display line flow');
      if (flow.type !== 'branch' && flow.type !== 'jump' && flow.type !== 'call') continue;
      if (typeof flow.targetRomOff !== 'number') continue;
      const toBlockId = romOffToBlockId.get(flow.targetRomOff >>> 0);
      if (!toBlockId || toBlockId === fromBlock.id) continue;
      let sources = inbound.get(toBlockId);
      if (!sources) {
        sources = [];
        inbound.set(toBlockId, sources);
      }
      sources.push({
        fromRomOff: line.romOff >>> 0,
        fromCpuAddr: typeof line.cpuAddr === 'number' ? line.cpuAddr & 0xffff : null,
        toRomOff: flow.targetRomOff >>> 0,
        toCpuAddr: typeof flow.target === 'number' ? flow.target & 0xffff : null
      });
    }
  }
  return inbound;
}


function getBankDisplayGranularity(mapper) {
  if (!mapper || typeof mapper !== 'object') return null;
  if (mapper.id === 'switch32k') return 0x8000;
  const meta = mapper.meta && typeof mapper.meta === 'object' ? mapper.meta : null;
  if (meta && meta.prgWindowModel === 'switch-32k') return 0x8000;
  return null;
}

function deriveRomBankIndex(romOff, granularity) {
  requireInteger(romOff, 'bank display romOff');
  requireInteger(granularity, 'bank display granularity');
  if (granularity <= 0) throw new Error('bank display granularity must be positive');
  return Math.floor((romOff >>> 0) / granularity);
}

function attachBankVariants(entries, mapper) {
  const granularity = getBankDisplayGranularity(mapper);
  if (!granularity) return entries;

  const entriesById = new Map();
  const variantsByCpuStart = new Map();

  for (const entry of entries) {
    requireInteger(entry.romStart, `${entry.id}.romStart`);
    entriesById.set(entry.id, entry);

    if (typeof entry.cpuStart !== 'number') continue;

    const bankIndex = deriveRomBankIndex(entry.romStart, granularity);
    const bankVariant = {
      blockId: entry.id,
      bankIndex,
      bankLabel: String(bankIndex),
      romStart: entry.romStart >>> 0,
      cpuStart: entry.cpuStart & 0xffff
    };
    entry.bankVariant = bankVariant;

    const groupKey = `cpu:${entry.cpuStart & 0xffff}`;
    let variants = variantsByCpuStart.get(groupKey);
    if (!variants) {
      variants = [];
      variantsByCpuStart.set(groupKey, variants);
    }
    variants.push(bankVariant);
  }

  for (const variants of variantsByCpuStart.values()) {
    variants.sort((a, b) => a.bankIndex - b.bankIndex || a.romStart - b.romStart || a.blockId.localeCompare(b.blockId));
    const anchorBlockId = variants[0]?.blockId || null;
    const frozenVariants = variants.map((variant) => ({ ...variant }));
    for (const variant of variants) {
      const entry = entriesById.get(variant.blockId);
      if (!entry) continue;
      entry.bankVariants = frozenVariants;
      entry.bankVariantAnchorBlockId = anchorBlockId;
      entry.isBankVariantAnchor = entry.id === anchorBlockId;
    }
  }

  return entries;
}

export function buildBlocksIndex(displayAnalysis) {
  requireObject(displayAnalysis, 'display analysis');
  const inbound = buildInboundRefsByBlockId(displayAnalysis);
  const blocks = requireArray(displayAnalysis.blocks, 'displayAnalysis.blocks');
  const entries = blocks.map((rawBlock, index) => {
    const block = requireDisplayBlock(rawBlock, `displayAnalysis.blocks[${index}]`);
    const firstLine = block.lines[0];
    const inboundSources = inbound.get(block.id) || [];
    return {
      id: block.id,
      romStart: block.romStart,
      romEnd: block.romEnd,
      pills: Array.isArray(block.pills) ? block.pills : [],
      loopGuides: Array.isArray(block.loopGuides) ? block.loopGuides : [],
      cpuStart: block.cpuStart !== null ? block.cpuStart : firstLine.cpuAddr,
      cpuEnd: block.cpuEnd,
      inbound: {
        count: inboundSources.length,
        sources: inboundSources
      },
      firstAsm: firstLine.asm,
      lineCount: block.lines.length,
      previewLines: block.lines.slice(0, 8).map(serializeLineForRenderer)
    };
  });
  return attachBankVariants(entries, displayAnalysis.mapper);
}

export function getDisplayBlock(codeViewState, blockId) {
  const { blockById } = requireObject(codeViewState, 'code view state');
  requireString(blockId, 'blockId');
  return blockById.get(blockId) || null;
}

export function getDisplayBlocks(codeViewState, blockIds) {
  const { blockById } = requireObject(codeViewState, 'code view state');
  const ids = requireArray(blockIds, 'blockIds');
  const blocks = [];
  const missing = [];
  for (const id of ids) {
    requireString(id, 'requested blockId');
    const block = blockById.get(id);
    if (block) blocks.push(block);
    else missing.push(id);
  }
  return { blocks, missing };
}
