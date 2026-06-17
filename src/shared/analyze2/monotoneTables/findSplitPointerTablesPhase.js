import { absoluteIndexRegisterForMode } from '../../cpu6502/addressingModes.js';
import { ANALYSIS_PHASE_IDS, ANALYSIS_PROGRESS_DETAIL_KINDS } from '../analysisConstants.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';
import { hexRom } from '../identity.js';
import {
  decodeRawInstructionAtRomOff,
  nextRawFallthroughRomOff,
  opcodeEntryForInstruction
} from '../functionExcavation/rawDecode.js';
import { MIN_PROMOTED_POINTER_TABLE_ENTRIES } from './pointerPromotionConstants.js';

const FIND_SPLIT_POINTER_TABLES_BYTES_PER_STEP = 2048;
const FIND_SPLIT_POINTER_TABLES_PROGRESS_INTERVAL_MS = 100;
const MIN_SPLIT_POINTER_HIGH_BYTE = 0x80;
const MAX_SPLIT_POINTER_HIGH_BYTE_SPAN = 0x04;
const MAX_READER_SEARCH_BACK_BYTES = 160;
const MAX_READER_PROBE_INSTRUCTIONS = 96;

function counterDefaults() {
  return {
    bytesScanned: 0,
    highRunsFound: 0,
    layoutsConsidered: 0,
    candidateTablesBuilt: 0,
    candidateTablesWithReaders: 0,
    readerSearches: 0,
    readerStartProbes: 0,
    readerWitnessesFound: 0,
    indexedReadIndexBases: 0,
    indexedReadIndexOccurrences: 0,
    tablesAdded: 0,
    skippedTooShortRun: 0,
    skippedNoLowSide: 0,
    skippedNoTableMappingContext: 0,
    skippedNoReaderWitness: 0
  };
}

function cloneSite(site, label) {
  requireObject(site, label);
  return {
    mapperContext: requireObject(site.mapperContext, `${label}.mapperContext`),
    contextKey: requireString(site.contextKey, `${label}.contextKey`),
    siteKey: requireString(site.siteKey, `${label}.siteKey`),
    cpuAddr: requireInteger(site.cpuAddr, `${label}.cpuAddr`) & 0xffff,
    romOff: requireInteger(site.romOff, `${label}.romOff`) >>> 0,
    backing: requireObject(site.backing, `${label}.backing`)
  };
}

function indexedLdaReadInfo(instruction, lowBaseCpuAddr, highBaseCpuAddr) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mnemonic !== 'LDA') return null;
  const indexRegister = absoluteIndexRegisterForMode(entry.mode);
  if (indexRegister === null) return null;
  const operand = instruction.operand & 0xffff;
  if (operand === (lowBaseCpuAddr & 0xffff)) {
    return {
      tableHalf: 'low',
      baseCpuAddr: lowBaseCpuAddr & 0xffff,
      indexRegister,
      instructionRomOff: instruction.romOff >>> 0
    };
  }
  if (operand === (highBaseCpuAddr & 0xffff)) {
    return {
      tableHalf: 'high',
      baseCpuAddr: highBaseCpuAddr & 0xffff,
      indexRegister,
      instructionRomOff: instruction.romOff >>> 0
    };
  }
  return null;
}

const EMPTY_INDEXED_LDA_OFFSETS = Object.freeze([]);

function buildIndexedLdaReadIndex(bytes) {
  const byBaseCpuAddr = new Map();
  let occurrences = 0;

  for (let romOff = 0; romOff + 2 < bytes.length; romOff += 1) {
    const opcode = bytes[romOff] & 0xff;
    if (opcode !== 0xbd && opcode !== 0xb9) continue;

    const baseCpuAddr = (bytes[romOff + 1] | (bytes[romOff + 2] << 8)) & 0xffff;
    let offsets = byBaseCpuAddr.get(baseCpuAddr);
    if (!offsets) {
      offsets = [];
      byBaseCpuAddr.set(baseCpuAddr, offsets);
    }
    offsets.push(romOff >>> 0);
    occurrences += 1;
  }

  return {
    byBaseCpuAddr,
    baseCount: byBaseCpuAddr.size >>> 0,
    occurrences: occurrences >>> 0
  };
}

function indexedLdaOffsetsForBase(index, baseCpuAddr) {
  const offsets = index.byBaseCpuAddr.get(baseCpuAddr & 0xffff);
  return offsets || EMPTY_INDEXED_LDA_OFFSETS;
}

function sameContextSiteForRomOff(mapper, romOff, contextKey, purpose) {
  if (typeof mapper.codeSitesForRomOff !== 'function') return null;
  const sites = mapper.codeSitesForRomOff(romOff >>> 0, { purpose });
  for (let i = 0; i < sites.length; i += 1) {
    const site = requireObject(sites[i], `${purpose} site ${i}`);
    if (requireString(site.contextKey, `${purpose} site ${i}.contextKey`) === contextKey) return site;
  }
  return null;
}

function tableAppearancePairs(context, table) {
  const mapper = requireObject(context.mapper, 'splitPointerTables mapper');
  if (typeof mapper.codeSitesForRomOff !== 'function') return [];
  const lowStartRomOff = requireInteger(table.lowStartRomOff, 'split pointer table.lowStartRomOff') >>> 0;
  const highStartRomOff = requireInteger(table.highStartRomOff, 'split pointer table.highStartRomOff') >>> 0;
  const lowSites = mapper.codeSitesForRomOff(lowStartRomOff, { purpose: 'splitPointerLowTableAppearance' });
  const highSites = mapper.codeSitesForRomOff(highStartRomOff, { purpose: 'splitPointerHighTableAppearance' });
  const highByContext = new Map();

  for (let i = 0; i < highSites.length; i += 1) {
    const site = requireObject(highSites[i], `split pointer high appearance ${i}`);
    const contextKey = requireString(site.contextKey, `split pointer high appearance ${i}.contextKey`);
    if (!highByContext.has(contextKey)) highByContext.set(contextKey, site);
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < lowSites.length; i += 1) {
    const lowSite = requireObject(lowSites[i], `split pointer low appearance ${i}`);
    const contextKey = requireString(lowSite.contextKey, `split pointer low appearance ${i}.contextKey`);
    if (seen.has(contextKey)) continue;
    const highSite = highByContext.get(contextKey);
    if (!highSite) continue;
    seen.add(contextKey);
    out.push({
      contextKey,
      mapperContext: requireObject(lowSite.mapperContext, `split pointer low appearance ${i}.mapperContext`),
      lowTableAppearance: cloneSite(lowSite, 'split pointer low appearance'),
      highTableAppearance: cloneSite(highSite, 'split pointer high appearance'),
      lowBaseCpuAddr: requireInteger(lowSite.cpuAddr, `split pointer low appearance ${i}.cpuAddr`) & 0xffff,
      highBaseCpuAddr: requireInteger(highSite.cpuAddr, 'split pointer high appearance.cpuAddr') & 0xffff
    });
  }
  return out;
}

function decodeLinearReaderFromStart({ prgBytes, mapper, startRomOff, appearancePair }) {
  const contextKey = requireString(appearancePair.contextKey, 'split pointer reader appearance contextKey');
  const startSite = sameContextSiteForRomOff(mapper, startRomOff >>> 0, contextKey, 'splitPointerReaderStart');
  if (!startSite) return { ok: false, reason: 'startNotInContext' };

  let romOff = startRomOff >>> 0;
  const seen = new Set();
  const instructions = [];
  let lowRead = null;
  let highRead = null;

  for (let step = 0; step < MAX_READER_PROBE_INSTRUCTIONS; step += 1) {
    if (romOff >= prgBytes.length) return { ok: false, reason: 'ranOffEnd' };
    if (seen.has(romOff)) return { ok: false, reason: 'repeatedRomOff' };
    seen.add(romOff);

    const decoded = decodeRawInstructionAtRomOff({ prgBytes, romOff });
    if (!decoded.ok) return { ok: false, reason: 'decodeFailed', detail: decoded };

    const instruction = requireObject(decoded.instruction, 'split pointer reader instruction');
    instructions.push(instruction.romOff >>> 0);

    const readInfo = indexedLdaReadInfo(
      instruction,
      appearancePair.lowBaseCpuAddr,
      appearancePair.highBaseCpuAddr
    );
    if (readInfo) {
      if (readInfo.tableHalf === 'low' && !lowRead) lowRead = readInfo;
      if (readInfo.tableHalf === 'high' && !highRead) highRead = readInfo;
    }

    const entry = opcodeEntryForInstruction(instruction);
    if (!entry) return { ok: false, reason: 'illegalOpcode' };
    if (entry.mnemonic === 'RTS' || entry.mnemonic === 'JMP') {
      if (!lowRead || !highRead) return { ok: false, reason: 'missingRead' };
      return {
        ok: true,
        witness: {
          contextKey,
          readerSite: cloneSite(startSite, 'split pointer reader start site'),
          lowRead,
          highRead,
          readerProof: {
            status: entry.mnemonic === 'JMP' ? 'jmpIndexedSplitPointerReader' : 'rtsIndexedSplitPointerReader',
            terminator: entry.mnemonic.toLowerCase(),
            startRomOff: startRomOff >>> 0,
            terminatorRomOff: instruction.romOff >>> 0,
            instructionCount: instructions.length >>> 0,
            visitedRomOffs: instructions,
            lowBaseCpuAddr: appearancePair.lowBaseCpuAddr & 0xffff,
            highBaseCpuAddr: appearancePair.highBaseCpuAddr & 0xffff
          }
        }
      };
    }
    if (entry.mnemonic === 'RTI' || entry.mnemonic === 'BRK') {
      return { ok: false, reason: 'nonReaderTerminator', detail: { mnemonic: entry.mnemonic } };
    }

    const nextRomOff = nextRawFallthroughRomOff(instruction);
    if (nextRomOff === null) return { ok: false, reason: 'noFallthrough' };
    romOff = nextRomOff >>> 0;
  }

  return { ok: false, reason: 'readerProbeInstructionLimit' };
}

function candidateReaderStarts(lowReadOffsets, highReadOffsets) {
  const starts = new Set();
  const readOffsets = lowReadOffsets.concat(highReadOffsets).sort((a, b) => a - b);
  for (const readRomOff of readOffsets) {
    const first = Math.max(0, (readRomOff >>> 0) - MAX_READER_SEARCH_BACK_BYTES);
    for (let start = first; start <= readRomOff; start += 1) starts.add(start >>> 0);
  }
  return Array.from(starts).sort((a, b) => a - b);
}

function findReaderWitnesses(context, table, counters, indexedReadIndex) {
  const prgBytes = context.prgBytes;
  const mapper = requireObject(context.mapper, 'splitPointerTables mapper');
  const appearancePairs = tableAppearancePairs(context, table);
  if (!appearancePairs.length) {
    counters.skippedNoTableMappingContext += 1;
    return [];
  }

  const witnesses = [];
  for (const appearancePair of appearancePairs) {
    counters.readerSearches += 1;
    const lowReadOffsets = indexedLdaOffsetsForBase(indexedReadIndex, appearancePair.lowBaseCpuAddr);
    if (!lowReadOffsets.length) continue;
    const highReadOffsets = indexedLdaOffsetsForBase(indexedReadIndex, appearancePair.highBaseCpuAddr);
    if (!highReadOffsets.length) continue;

    const starts = candidateReaderStarts(lowReadOffsets, highReadOffsets);
    for (const startRomOff of starts) {
      counters.readerStartProbes += 1;
      const decoded = decodeLinearReaderFromStart({
        prgBytes,
        mapper,
        startRomOff,
        appearancePair
      });
      if (!decoded.ok) continue;
      counters.readerWitnessesFound += 1;
      witnesses.push(decoded.witness);
      break;
    }
  }
  return witnesses;
}

function makeSplitPointerTable(tableIndex, layout, lowStartRomOff, highStartRomOff, entryCount, prgBytes) {
  const startRomOff = Math.min(lowStartRomOff, highStartRomOff) >>> 0;
  const endRomOff = (Math.max(lowStartRomOff, highStartRomOff) + entryCount) >>> 0;
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    const lowEntryRomOff = (lowStartRomOff + index) >>> 0;
    const highEntryRomOff = (highStartRomOff + index) >>> 0;
    const lowByte = prgBytes[lowEntryRomOff] & 0xff;
    const highByte = prgBytes[highEntryRomOff] & 0xff;
    entries.push({
      index,
      entryRomOff: lowEntryRomOff,
      lowEntryRomOff,
      highEntryRomOff,
      lowByte,
      highByte,
      value: (lowByte | (highByte << 8)) & 0xffff
    });
  }

  return {
    tableId: `splitPointer:${layout}:${hexRom(startRomOff)}:${entryCount}`,
    kind: 'splitPointerTable',
    layout,
    monotonicity: 'highByteNonDecreasing',
    tableIndex: tableIndex >>> 0,
    startRomOff,
    endRomOff,
    byteLength: endRomOff - startRomOff,
    entryCount,
    lowStartRomOff: lowStartRomOff >>> 0,
    highStartRomOff: highStartRomOff >>> 0,
    entries,
    readerWitnesses: [],
    pointerPromotion: {
      status: 'notTested'
    }
  };
}

function appendTablesToMonotoneContext(context, result) {
  const existing = context.monotoneTables || {
    kind: 'monotoneTables',
    scanner: null,
    tables: [],
    counters: {}
  };
  const tables = Array.isArray(existing.tables) ? existing.tables : [];
  for (const table of result.tables) tables.push(table);
  context.monotoneTables = {
    ...existing,
    tables,
    counters: {
      ...(existing.counters || {}),
      splitPointerTablesFound: result.counters.tablesAdded >>> 0,
      splitPointerReaderWitnesses: result.counters.readerWitnessesFound >>> 0
    }
  };
}

export function createFindSplitPointerTablesPhase(context, options = {}) {
  const phaseOptions = options && typeof options === 'object' ? options : {};
  const bytesPerStep = Number.isInteger(phaseOptions.bytesPerStep) && phaseOptions.bytesPerStep > 0
    ? phaseOptions.bytesPerStep
    : FIND_SPLIT_POINTER_TABLES_BYTES_PER_STEP;

  const result = {
    kind: 'splitPointerTables',
    scanner: {
      layout: 'adjacentSplitLowHighOrHighLow',
      monotonicity: 'highByteNonDecreasing',
      maxHighByteSpan: MAX_SPLIT_POINTER_HIGH_BYTE_SPAN
    },
    tables: [],
    counters: counterDefaults()
  };

  let romOff = 0;
  let complete = false;
  let finalized = false;
  let lastProgressNowAt = 0;
  const indexedReadIndex = buildIndexedLdaReadIndex(context.prgBytes);
  result.counters.indexedReadIndexBases = indexedReadIndex.baseCount;
  result.counters.indexedReadIndexOccurrences = indexedReadIndex.occurrences;

  function shouldPostProgressNow(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressNowAt < FIND_SPLIT_POINTER_TABLES_PROGRESS_INTERVAL_MS) return false;
    lastProgressNowAt = now;
    return true;
  }

  function buildAndMaybeAdd(layout, lowStartRomOff, highStartRomOff, entryCount) {
    const prgBytes = context.prgBytes;
    result.counters.layoutsConsidered += 1;
    if (lowStartRomOff < 0 || lowStartRomOff + entryCount > prgBytes.length) {
      result.counters.skippedNoLowSide += 1;
      return;
    }

    const table = makeSplitPointerTable(
      result.counters.candidateTablesBuilt,
      layout,
      lowStartRomOff >>> 0,
      highStartRomOff >>> 0,
      entryCount >>> 0,
      prgBytes
    );
    result.counters.candidateTablesBuilt += 1;

    const witnesses = findReaderWitnesses(context, table, result.counters, indexedReadIndex);
    if (!witnesses.length) {
      result.counters.skippedNoReaderWitness += 1;
      return;
    }

    table.readerWitnesses = witnesses;
    result.tables.push(table);
    result.counters.candidateTablesWithReaders += 1;
    result.counters.tablesAdded = result.tables.length >>> 0;
  }

  function scanNextHighRun(maxBytes) {
    const prgBytes = context.prgBytes;
    const scanLimit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : prgBytes.length;
    let scannedThisCall = 0;

    while (romOff < prgBytes.length) {
      if (scannedThisCall >= scanLimit) return true;
      const first = prgBytes[romOff] & 0xff;
      result.counters.bytesScanned += 1;
      scannedThisCall += 1;
      if (first < MIN_SPLIT_POINTER_HIGH_BYTE) {
        romOff += 1;
        continue;
      }

      const highStartRomOff = romOff >>> 0;
      let highEndRomOff = (romOff + 1) >>> 0;
      let previous = first;
      while (highEndRomOff < prgBytes.length) {
        const next = prgBytes[highEndRomOff] & 0xff;
        if (next < MIN_SPLIT_POINTER_HIGH_BYTE || next < previous) break;
        if (next - first > MAX_SPLIT_POINTER_HIGH_BYTE_SPAN) break;
        previous = next;
        highEndRomOff += 1;
        result.counters.bytesScanned += 1;
      }

      const entryCount = (highEndRomOff - highStartRomOff) >>> 0;
      result.counters.highRunsFound += 1;
      if (entryCount < MIN_PROMOTED_POINTER_TABLE_ENTRIES) {
        result.counters.skippedTooShortRun += 1;
      } else {
        buildAndMaybeAdd('splitLoHiAdjacent', highStartRomOff - entryCount, highStartRomOff, entryCount);
        buildAndMaybeAdd('splitHiLoAdjacent', highEndRomOff, highStartRomOff, entryCount);
      }

      romOff = highEndRomOff >>> 0;
      return true;
    }

    complete = true;
    return true;
  }


  function finalize() {
    if (finalized) return;
    appendTablesToMonotoneContext(context, result);
    context.splitPointerTables = result;
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES,
      status: 'complete',
      counters: { ...result.counters }
    });
    finalized = true;
    complete = true;
  }

  return {
    name: ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES,
    stepOne() {
      requireObject(context.mapper, 'findSplitPointerTables mapper');
      if (complete) {
        finalize();
        return { status: 'complete', progress: this.progress() };
      }

      const limit = Math.max(1, bytesPerStep >>> 0);
      let didWork = false;
      while (!complete && !didWork) didWork = scanNextHighRun(limit);
      if (!complete) {
        context.splitPointerTables = result;
        return {
          status: 'running',
          phase: ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES,
          progressNow: shouldPostProgressNow(false)
        };
      }

      finalize();
      shouldPostProgressNow(true);
      return { status: 'complete', progress: this.progress() };
    },
    progress() {
      return {
        phase: ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES,
        romOff: Math.min(romOff >>> 0, context.prgBytes.length >>> 0),
        totalBytes: context.prgBytes.length >>> 0,
        ...result.counters,
        detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.FIND_SPLIT_POINTER_TABLES,
        details: {
          romOff: Math.min(romOff >>> 0, context.prgBytes.length >>> 0),
          totalBytes: context.prgBytes.length >>> 0,
          ...result.counters
        }
      };
    }
  };
}
