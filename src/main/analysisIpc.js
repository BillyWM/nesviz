import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { parseInes, parseInesHeader, readVectorsFromLastPrgBank } from '../shared/rom/ines.js';
import { getStaticAnalysisSupportInfo } from '../shared/rom/mapperInfo.js';
import { parseNesCdl } from '../shared/analyze/cdl/nesCdl.js';
import { updateRecentRoms } from './menu.js';
import { appendAnalysisLogLines } from './analysisLogWindow.js';
import { getTuningState } from './tuningState.js';
import { buildGraphData } from '../shared/analyze/visual/buildGraphData.js';
import { resolveDiscoveredVectorDestinationsByFamily } from '../shared/analyze/vectorNavigation.js';
import { notifyMemoryMapDataChanged } from './memoryMapWindow.js';
import { notifyHeatmapDataChanged } from './heatmapWindow.js';
import { notifyMarkovMapDataChanged } from './markovMapWindow.js';
import { notifyGraphDataChanged } from './graphWindow.js';
import { hasAnalysisCache, loadAnalysisCache, saveAnalysisCache } from './analysisCache.js';
import { loadGraphLayoutCache, saveGraphLayoutCache } from './graphLayoutCache.js';
import { invalidateAnalysisArtifacts } from './analysisInvalidation.js';
import { loadMarkovModel, loadCombinedCodeProfile } from './markovStore.js';
import { scoreBlockWithMarkovModel, scoreBlockWithCombinedCodeProfile } from '../shared/analyze/markov/opcodeScoring.js';
import { scoreFeatureVectorWithCodeProfile } from '../shared/analyze/markov/opcodeProfile.js';
import { fmtHex, fmtHexRange } from '../shared/utils/hexUtils.js';
import { parseAddressKey } from '../shared/utils/addressKeyUtils.js';
import { coalesceOccupiedRanges, coalesceTypedRanges } from '../shared/utils/rangeUtils.js';
import { computeShannonEntropyByte } from '../shared/utils/byteStatsUtils.js';
import { percentile } from '../shared/utils/statsUtils.js';
import { getFolderSelectionKey, normalizeFolderPaths, normFolderPath, resolveFolderPath } from './utils/folderPathUtils.js';
import { buildVsaLineDebugForBlock } from '../shared/analyze/vsa/lineDebug.js';
import {
  getBookmarksForRomHash,
  setBookmarkForRomHash,
  getLabelsForRomHash,
  setLabelForRomHash,
  getAddrLabelsForRomHash,
  setAddrLabelForRomHash,
  recordRecentRomPath,
  getRecentRomPaths
} from './userDataStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let nextFolderScanId = 1;

// Single-ROM app: the currently loaded ROM and its analysis state.
let active = null;

// If static analysis is running, this holds the active worker so we can terminate it when switching ROMs.
let activeWorker = null;

function formatAnalysisLogLines({ filename, mapperKind, analysis }) {
  const ts = new Date().toLocaleTimeString();
  const probable = analysis?.probable || {};
  const stats = analysis?.stats || {};
  const coverage = typeof stats.coveragePct === 'number' ? `${stats.coveragePct.toFixed(2)}%` : 'n/a';
  const capHit = probable.globalCapHit ? 'yes' : 'no';
  const cap = Number.isFinite(probable.maxPromotedChunks) ? probable.maxPromotedChunks : 'n/a';
  const lines = [
    `[${ts}] Static analysis complete for ${filename || '(unknown ROM)'} (${mapperKind || 'NROM'}).`,
    `Blocks: ${stats.blockCount ?? 'n/a'} · Coverage: ${coverage}.`,
    `Probable chunks: kept ${probable.keptChunkCount ?? 0}, promoted ${probable.promotedChunkCount ?? 0}, seeds ${probable.promotedSeedCount ?? 0}. Global cap hit: ${capHit} (cap ${cap}).`
  ];
  if (Number.isFinite(analysis?.debug?.vectorSeedCount)) {
    lines.push(`Vector/context seed sites: ${analysis.debug.vectorSeedCount}.`);
  }
  const regionSummaries = Array.isArray(probable.regionSummaries) ? probable.regionSummaries : [];
  for (const region of regionSummaries) {
    const label = Number.isFinite(region.bankIndex)
      ? `PRG bank ${region.bankIndex}`
      : `Range ${fmtHexRange(region.rangeStart, region.rangeEnd)}`;
    const best = Number.isFinite(region.bestScore) ? region.bestScore.toFixed(2) : 'n/a';
    lines.push(`  ${label} [${fmtHexRange(region.rangeStart, region.rangeEnd)}]: probe starts ${region.probeStartCount ?? 0}, passing ${region.passingCandidateCount ?? 0}, kept ${region.keptCandidateCount ?? 0}, best score ${best}.`);
  }
  return lines;
}

function getStaticAnalysisInfoForMapperMeta(analysisMapper) {
  return getStaticAnalysisSupportInfo(analysisMapper || null);
}

function getStaticAnalysisInfoForHeader(header) {
  return getStaticAnalysisInfoForMapperMeta(header?.analysisMapper || null);
}

function decorateRomFolderItem(item) {
  const base = item && typeof item === 'object' ? item : {};
  const info = getStaticAnalysisInfoForMapperMeta(base.analysisMapper || null);
  return {
    ...base,
    isAnalyzable: !!info.isAnalyzable,
    analysisKind: info.analysisKind || null
  };
}

function toCachedRomFolderItem({ fullPath, filename, header, nromKind }) {
  return {
    filePath: fullPath,
    filename,
    prgBytes: header.prgBytes,
    chrBytes: header.chrBytes,
    mapperNumber: header.mapperNumber,
    mapperName: header.mapperName,
    nromKind,
    hasTrainer: header.hasTrainer,
    isInes2: header.isInes2,
    analysisMapper: header.analysisMapper || null
  };
}

function clearActiveAnalysisState(s) {
  if (!s) return;
  s.rawAnalysis = null;
  s.displayAnalysis = null;
  s.rawToDisplayBlockIds = null;
  s.blockById = null;
}

function getVectorDestinationsByFamilyForActive(s) {
  if (!s?.ines?.prg || !s?.displayAnalysis?.blocks || !s?.vectors) return null;
  return resolveDiscoveredVectorDestinationsByFamily({
    prgBytes: s.ines.prg,
    vectors: s.vectors,
    mapperKind: s.displayAnalysis?.mapper?.kind || 'NROM',
    mapperMeta: s.displayAnalysis?.mapper?.meta || s.ines?.analysisMapper || null,
    blocks: s.displayAnalysis.blocks
  });
}

function applyAnalysisResultToActiveState(s, result) {
  if (!s) throw new Error('No active ROM');
  const rawAnalysis = result?.rawAnalysis ?? null;
  const displayAnalysis = result?.displayAnalysis ?? null;
  const rawToDisplayBlockIds = result?.rawToDisplayBlockIds ?? null;
  if (!displayAnalysis || !Array.isArray(displayAnalysis.blocks)) {
    throw new Error('Invalid analysis payload');
  }
  s.rawAnalysis = rawAnalysis;
  s.displayAnalysis = displayAnalysis;
  s.rawToDisplayBlockIds = rawToDisplayBlockIds;
  s.blockById = new Map(displayAnalysis.blocks.map((b) => [b.id, b]));
}


function getBlockConfidenceById(blocks) {
  const map = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id || '');
    if (!id) continue;
    const confidence = block?.confidence === 'probable' ? 'probable' : 'certain';
    const prev = map.get(id);
    if (prev === 'certain') continue;
    map.set(id, confidence);
  }
  return map;
}

function classifyGroupType(group, blockConfidenceById) {
  const baseType = group?.space === 'rom' ? 'romData' : 'group';
  const touching = Array.isArray(group?.touchingRawBlockIds) ? group.touchingRawBlockIds : [];
  if (!touching.length) return baseType;
  let sawProbable = false;
  for (const rawBlockId of touching) {
    const conf = blockConfidenceById.get(String(rawBlockId));
    if (conf === 'certain') return baseType;
    if (conf === 'probable') sawProbable = true;
  }
  return sawProbable ? `${baseType}Light` : baseType;
}

function applyTypedRange(types, start, end, type) {
  const limit = Math.min(types.length, end | 0);
  for (let i = Math.max(0, start | 0); i < limit; i++) {
    const prev = types[i] || 'empty';
    if (prev === 'code') continue;
    if (type === 'code') {
      types[i] = 'code';
      continue;
    }
    if (type === 'codeLight') {
      types[i] = prev === 'empty' ? 'codeLight' : prev;
      continue;
    }
    if (prev === 'codeLight') continue;
    if (type === 'romData' || type === 'group') {
      types[i] = type;
      continue;
    }
    if (type === 'romDataLight') {
      if (prev === 'empty' || prev === 'groupLight') types[i] = 'romDataLight';
      continue;
    }
    if (type === 'groupLight') {
      if (prev === 'empty') types[i] = 'groupLight';
    }
  }
}

function getPrgRegionSizeBytes(analysisMapper, prgSize) {
  const meta = analysisMapper || null;
  if (meta?.prgWindowModel === 'mmc1-variable') return 16 * 1024;
  const swap = Number(meta?.prgSwapUnitBytes);
  if (Number.isFinite(swap) && swap > 0) return swap | 0;
  const slots = Array.isArray(meta?.prgFetchLayout?.slots) ? meta.prgFetchLayout.slots : [];
  const slotSizes = slots
    .map((slot) => Number(slot?.sizeBytes))
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => a - b);
  if (slotSizes.length) return slotSizes[0] | 0;
  return Math.max(1, prgSize | 0);
}

const HEATMAP_GRANULARITIES = [8, 16, 32, 48, 64];
const HEATMAP_ROW_CELL_COUNT = 64;
const CHR_HEATMAP_REGION_SIZE_BYTES = 8 * 1024;

function buildHeatmapRegions(bytes, regionSizeBytes, granularities) {
  const sizeBytes = bytes?.length | 0;
  const safeRegionSize = Math.max(1, regionSizeBytes | 0);
  const regions = [];
  for (let start = 0, index = 0; start < sizeBytes; start += safeRegionSize, index++) {
    const end = Math.min(sizeBytes, start + safeRegionSize);
    const cellsByGranularity = {};
    for (const granularity of granularities) {
      const g = Math.max(1, granularity | 0);
      const cells = [];
      for (let cellStart = start; cellStart < end; cellStart += g) {
        const cellEnd = Math.min(end, cellStart + g);
        cells.push(computeShannonEntropyByte(bytes, cellStart, cellEnd));
      }
      cellsByGranularity[String(g)] = cells;
    }
    regions.push({ index, start, end, cellsByGranularity });
  }
  return regions;
}

function buildHeatmapCacheForActive(s) {
  if (!s?.ines) return null;
  const analysisMapper = s.ines.analysisMapper || s.displayAnalysis?.mapper?.meta || null;
  const prgSize = s.ines.prg?.length | 0;
  const chrSize = s.ines.chr?.length | 0;
  const prgRegionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const chrRegionSizeBytes = Math.min(CHR_HEATMAP_REGION_SIZE_BYTES, Math.max(1, chrSize || CHR_HEATMAP_REGION_SIZE_BYTES));

  return {
    granularities: HEATMAP_GRANULARITIES.slice(),
    rowCellCount: HEATMAP_ROW_CELL_COUNT,
    metric: 'shannonEntropy',
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes: prgRegionSizeBytes,
      regions: buildHeatmapRegions(s.ines.prg, prgRegionSizeBytes, HEATMAP_GRANULARITIES)
    },
    chr: chrSize > 0
      ? {
          sizeBytes: chrSize,
          regionSizeBytes: chrRegionSizeBytes,
          regions: buildHeatmapRegions(s.ines.chr, chrRegionSizeBytes, HEATMAP_GRANULARITIES)
        }
      : null
  };
}

function ensureHeatmapCacheForActive(s) {
  if (!s?.ines) return null;
  if (!s.heatmapCache) s.heatmapCache = buildHeatmapCacheForActive(s);
  return s.heatmapCache;
}

function buildHeatmapCodeOverlayRegions(s, cache) {
  const prgSize = cache?.prg?.sizeBytes | 0;
  const regions = Array.isArray(cache?.prg?.regions) ? cache.prg.regions : [];
  const overlayBits = new Uint8Array(Math.max(0, prgSize));
  const prgOccupancyTypes = s?.displayAnalysis?.prgOccupancy?.byteTypes instanceof Uint8Array
    ? s.displayAnalysis.prgOccupancy.byteTypes
    : null;

  if (prgOccupancyTypes?.length) {
    const limit = Math.min(prgSize, prgOccupancyTypes.length);
    for (let i = 0; i < limit; i++) {
      if ((prgOccupancyTypes[i] | 0) === 1) overlayBits[i] = 1;
    }
  } else {
    const blocks = Array.isArray(s?.displayAnalysis?.blocks) ? s.displayAnalysis.blocks : [];
    for (const block of blocks) {
      const romStart = Number(block?.romStart);
      const romEnd = Number(block?.romEnd);
      if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
      const start = Math.max(0, Math.min(prgSize, romStart | 0));
      const end = Math.max(start, Math.min(prgSize, romEnd | 0));
      for (let i = start; i < end; i++) overlayBits[i] = 1;
    }
  }

  return regions.map((region) => ({
    index: region.index,
    start: region.start,
    end: region.end,
    overlayRanges: coalesceOccupiedRanges(overlayBits, region.start, region.end)
  }));
}

function buildHeatmapDataForActive() {
  const s = active;
  if (!s?.ines) {
    return {
      ok: true,
      hasRom: false,
      hasAnalysis: false,
      metric: 'shannonEntropy',
      granularities: HEATMAP_GRANULARITIES.slice(),
      defaultGranularity: HEATMAP_GRANULARITIES[0],
      rowCellCount: HEATMAP_ROW_CELL_COUNT,
        rom: null,
      prg: null,
      chr: null
    };
  }

  const cache = ensureHeatmapCacheForActive(s);
  const overlayRegions = buildHeatmapCodeOverlayRegions(s, cache);

  return {
    ok: true,
    hasRom: true,
    hasAnalysis: !!s.displayAnalysis,
    metric: cache.metric,
    granularities: cache.granularities,
    defaultGranularity: cache.granularities[0],
    rowCellCount: cache.rowCellCount,
    rom: {
      filename: s.filename,
      mapperNumber: s.ines.mapperNumber,
      prgSize: s.ines.prg.length,
      chrSize: s.ines.chr.length
    },
    prg: {
      ...cache.prg,
      codeOverlayRegions: overlayRegions
    },
    chr: cache.chr
  };
}

function buildMemoryMapDataForActive() {
  const s = active;
  if (!s?.ines) {
    return {
      ok: true,
      hasRom: false,
      hasAnalysis: false,
      rowWidthBytes: 64,
      cellSizePx: 16,
      ram: null,
      prg: null,
      rom: null,
      mapper: null
    };
  }

  const rowWidthBytes = 64;
  const cellSizePx = 16;
  const prgBytes = s.ines.prg;
  const prgSize = prgBytes?.length | 0;
  const analysis = s.displayAnalysis || null;
  const groups = Array.isArray(analysis?.memoryDiscoveries?.groups) ? analysis.memoryDiscoveries.groups : [];
  const oamDmaTransfers = Array.isArray(analysis?.memoryDiscoveries?.oamDmaTransfers) ? analysis.memoryDiscoveries.oamDmaTransfers : [];
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const blockConfidenceById = getBlockConfidenceById(blocks);

  const ramTypes = new Array(0x800).fill('empty');
  for (const group of groups) {
    if (group?.space === 'rom') continue;
    const groupType = classifyGroupType(group, blockConfidenceById);
    for (const key of group?.memberAddressKeys || []) {
      const parsed = parseAddressKey(key);
      if (!parsed) continue;
      if (parsed.space === 'zp') {
        if (parsed.addr >= 0 && parsed.addr < 0x100) applyTypedRange(ramTypes, parsed.addr, parsed.addr + 1, groupType);
      } else if (parsed.space === 'ram') {
        if (parsed.addr >= 0 && parsed.addr < 0x800) applyTypedRange(ramTypes, parsed.addr, parsed.addr + 1, groupType);
      }
    }
  }

  for (const transfer of oamDmaTransfers) {
    const exact = transfer?.exactSource || null;
    if (!exact || !exact.qualifiesForMemoryMap) continue;
    const canonicalSpace = exact.canonicalSpace;
    const canonicalStart = Number(exact.canonicalStart);
    const canonicalEndExclusive = Number(exact.canonicalEndExclusive);
    if (!Number.isFinite(canonicalStart) || !Number.isFinite(canonicalEndExclusive)) continue;
    if (!(canonicalSpace === 'zp' || canonicalSpace === 'ram')) continue;
    if (canonicalStart < 0 || canonicalEndExclusive > 0x800 || canonicalEndExclusive <= canonicalStart) continue;
    const groupType = classifyGroupType({ space: 'ram', touchingRawBlockIds: transfer?.touchingRawBlockIds || [] }, blockConfidenceById);
    applyTypedRange(ramTypes, canonicalStart, canonicalEndExclusive, groupType);
  }

  const ramOccupiedRanges = coalesceTypedRanges(ramTypes, 0, ramTypes.length);

  const prgTypes = new Array(Math.max(0, prgSize)).fill('empty');
  const prgOccupancyTypes = analysis?.prgOccupancy?.byteTypes instanceof Uint8Array
    ? analysis.prgOccupancy.byteTypes
    : null;
  if (prgOccupancyTypes && prgOccupancyTypes.length) {
    const limit = Math.min(prgTypes.length, prgOccupancyTypes.length);
    for (let i = 0; i < limit; i++) {
      const occ = prgOccupancyTypes[i] | 0;
      prgTypes[i] = occ === 1 ? 'code' : occ === 2 ? 'romData' : 'empty';
    }
  } else {
    for (const group of groups) {
      if (group?.space !== 'rom') continue;
      const groupType = classifyGroupType(group, blockConfidenceById);
      for (const span of group?.spans || []) {
        const start = Math.max(0, Math.min(prgTypes.length, Number(span?.start) | 0));
        const end = Math.max(start, Math.min(prgTypes.length, (Number(span?.end) | 0) + 1));
        applyTypedRange(prgTypes, start, end, groupType);
      }
    }

    for (const block of blocks) {
      const romStart = Number(block?.romStart);
      const romEnd = Number(block?.romEnd);
      if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
      const start = Math.max(0, Math.min(prgTypes.length, romStart | 0));
      const end = Math.max(start, Math.min(prgTypes.length, romEnd | 0));
      applyTypedRange(prgTypes, start, end, 'code');
    }
  }

  const analysisMapper = s.ines.analysisMapper || analysis?.mapper?.meta || null;
  const regionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const regions = [];
  for (let start = 0, index = 0; start < prgSize; start += regionSizeBytes, index++) {
    const end = Math.min(prgSize, start + regionSizeBytes);
    regions.push({
      index,
      start,
      end,
      occupiedRanges: coalesceTypedRanges(prgTypes, start, end)
    });
  }

  return {
    ok: true,
    hasRom: true,
    hasAnalysis: !!analysis,
    rowWidthBytes,
    cellSizePx,
    rom: {
      filename: s.filename,
      mapperNumber: s.ines.mapperNumber,
      prgSize
    },
    mapper: analysis?.mapper || { kind: null, meta: analysisMapper },
    ram: {
      sizeBytes: 0x800,
      occupiedRanges: ramOccupiedRanges
    },
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes,
      regions
    }
  };
}


function clampMarkovSource(source) {
  return source === 'probablePlus' ? 'probablePlus' : 'confirmed';
}

function clampMarkovDisplayedCodeType(codeType) {
  return codeType === 'probablePlus' ? 'probablePlus' : 'confirmed';
}

function clampMarkovFamily(family) {
  if (family === 'mnemonic') return 'mnemonic';
  if (family === 'addressing') return 'addressing';
  return 'opcode';
}

function clampMarkovMetric(metric) {
  const allowed = new Set(['avgLogLikelihood', 'crossEntropyBits', 'perplexity', 'unseenTransitionRatio', 'robustMahalanobisDistance']);
  return allowed.has(metric) ? metric : 'avgLogLikelihood';
}

function clampMarkovOrder(order) {
  const n = Number(order);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, n | 0));
}

function isHigherBetterMarkovMetric(metric) {
  return metric === 'avgLogLikelihood';
}

function normalizeMarkovValue(value, low, high, metric) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return 1;
  const rawNormalized = (value - low) / (high - low);
  const clamped = Math.max(0, Math.min(1, rawNormalized));
  return isHigherBetterMarkovMetric(metric) ? clamped : (1 - clamped);
}

function buildMarkovRanges(spans, start, end) {
  const safeSpans = Array.isArray(spans)
    ? spans
        .map((span) => ({
          start: Number(span?.start),
          end: Number(span?.end),
          metricValue: Number(span?.metricValue),
          normalized: Number(span?.normalized),
          percentile: Number(span?.percentile),
          bucketKey: typeof span?.bucketKey === 'string' ? span.bucketKey : '',
          rawBlockId: String(span?.rawBlockId || ''),
          confidence: span?.confidence === 'probable' ? 'probable' : 'certain'
        }))
        .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
        .sort((a, b) => a.start - b.start || a.end - b.end)
    : [];

  const ranges = [];
  for (const span of safeSpans) {
    const overlapStart = Math.max(start, span.start);
    const overlapEnd = Math.min(end, span.end);
    if (overlapEnd <= overlapStart) continue;
    const prev = ranges[ranges.length - 1] || null;
    const trimmedStart = prev ? Math.max(overlapStart, prev.end) : overlapStart;
    if (overlapEnd <= trimmedStart) continue;
    ranges.push({
      start: trimmedStart - start,
      end: overlapEnd - start,
      type: 'markov',
      metricValue: span.metricValue,
      normalized: span.normalized,
      percentile: span.percentile,
      bucketKey: span.bucketKey,
      rawBlockId: span.rawBlockId,
      confidence: span.confidence
    });
  }
  return ranges;
}

async function buildMarkovMapDataForActive(payload) {
  const s = active;
  const corpus = clampMarkovSource(payload?.corpus ?? payload?.source);
  const displayedCodeType = clampMarkovDisplayedCodeType(payload?.displayedCodeType ?? payload?.code ?? payload?.source);
  const family = clampMarkovFamily(payload?.family);
  const metric = clampMarkovMetric(payload?.metric);
  const order = clampMarkovOrder(payload?.order);
  const usesCombinedMetric = metric === 'robustMahalanobisDistance';

  if (!s?.ines) {
    return {
      ok: true,
      hasRom: false,
      hasAnalysis: false,
      rowWidthBytes: 64,
      cellSizePx: 16,
      corpus,
      displayedCodeType,
      family,
      metric,
      order,
      prg: null,
      rom: null,
      normalization: null,
      modelPath: null,
      modelCorpus: null
    };
  }

  let model = null;
  let modelsByFamily = null;
  let codeProfile = null;
  try {
    if (usesCombinedMetric) {
      modelsByFamily = {
        opcode: await loadMarkovModel(corpus, 'opcode'),
        addressing: await loadMarkovModel(corpus, 'addressing'),
        mnemonic: await loadMarkovModel(corpus, 'mnemonic')
      };
      codeProfile = await loadCombinedCodeProfile(corpus);
    } else {
      model = await loadMarkovModel(corpus, family);
    }
  } catch (err) {
    return {
      ok: false,
      error: usesCombinedMetric
        ? `Failed to load Markov artifacts: ${err?.message || String(err)}`
        : `Failed to load ${family} Markov model: ${err?.message || String(err)}`,
      hasRom: true,
      hasAnalysis: !!s.displayAnalysis,
      corpus,
      displayedCodeType,
      family,
      metric,
      order
    };
  }

  const rowWidthBytes = 64;
  const cellSizePx = 16;
  const prgSize = s.ines.prg?.length | 0;
  const analysis = s.displayAnalysis || null;
  const rawBlocks = Array.isArray(s.rawAnalysis?.blocks)
    ? s.rawAnalysis.blocks
    : (Array.isArray(analysis?.blocks) ? analysis.blocks : []);

  const scoredSpans = [];
  const metricValues = [];
  for (const block of rawBlocks) {
    const confidence = block?.confidence === 'probable' ? 'probable' : 'certain';
    if (displayedCodeType === 'confirmed' && confidence !== 'certain') continue;
    if (displayedCodeType === 'probablePlus' && confidence !== 'certain' && confidence !== 'probable') continue;
    const scored = usesCombinedMetric
      ? scoreBlockWithCombinedCodeProfile(block, modelsByFamily, codeProfile, scoreFeatureVectorWithCodeProfile)
      : scoreBlockWithMarkovModel(block, model, order, family);
    if (!scored) continue;
    const romStart = Number(scored.romStart);
    const romEnd = Number(scored.romEnd);
    if (!Number.isFinite(romStart) || !Number.isFinite(romEnd) || romEnd <= romStart) continue;
    const metricValue = Number(usesCombinedMetric ? scored?.metrics?.distance : scored?.metrics?.[metric]);
    if (!Number.isFinite(metricValue)) continue;
    scoredSpans.push({
      rawBlockId: scored.rawBlockId,
      confidence: scored.confidence,
      start: Math.max(0, Math.min(prgSize, romStart | 0)),
      end: Math.max(0, Math.min(prgSize, romEnd | 0)),
      metricValue,
      bucketKey: typeof scored?.metrics?.bucketKey === 'string' ? scored.metrics.bucketKey : ''
    });
    metricValues.push(metricValue);
  }

  const sortedMetricValues = metricValues.slice().sort((a, b) => a - b);
  const percentileLow = percentile(sortedMetricValues, 0.05);
  const percentileHigh = percentile(sortedMetricValues, 0.95);
  for (const span of scoredSpans) {
    span.normalized = normalizeMarkovValue(span.metricValue, percentileLow, percentileHigh, metric);
    span.percentile = span.normalized * 100;
  }

  const analysisMapper = s.ines.analysisMapper || analysis?.mapper?.meta || null;
  const regionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const regions = [];
  for (let start = 0, index = 0; start < prgSize; start += regionSizeBytes, index += 1) {
    const end = Math.min(prgSize, start + regionSizeBytes);
    regions.push({
      index,
      start,
      end,
      occupiedRanges: buildMarkovRanges(scoredSpans, start, end)
    });
  }

  return {
    ok: true,
    hasRom: true,
    hasAnalysis: !!analysis,
    rowWidthBytes,
    cellSizePx,
    corpus,
    displayedCodeType,
    family,
    metric,
    order,
    modelPath: null,
    modelCorpus: (usesCombinedMetric ? modelsByFamily?.opcode?.corpus : model?.corpus) || corpus,
    normalization: {
      rawMin: sortedMetricValues.length ? sortedMetricValues[0] : null,
      rawMax: sortedMetricValues.length ? sortedMetricValues[sortedMetricValues.length - 1] : null,
      percentileLow,
      percentileHigh,
      scoredBlockCount: scoredSpans.length
    },
    rom: {
      filename: s.filename,
      mapperNumber: s.ines.mapperNumber,
      prgSize
    },
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes,
      regions
    }
  };
}

function runStaticAnalysisInWorker(payload, opts = null) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const onWorker = typeof opts?.onWorker === 'function' ? opts.onWorker : null;
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'analysisWorker.js');

    // In preview/production builds the worker is emitted as a separate main entry. If it's missing,
    // the user likely needs to rebuild.
    fs.access(workerPath).then(() => {
      const worker = new Worker(workerPath, { workerData: payload });
      if (onWorker) {
        try { onWorker(worker); } catch {}
      }

      let done = false;
      function finishOk(msg) {
        if (done) return;
        done = true;
        worker.removeAllListeners();
        resolve(msg);
      }
      function finishErr(err) {
        if (done) return;
        done = true;
        worker.removeAllListeners();
        reject(err);
      }

      worker.on('message', (msg) => {
        // Progress messages stream while the worker runs.
        if (msg && msg.kind === 'vsaProgress') {
          if (onProgress) {
            try { onProgress(msg); } catch {}
          }
          return;
        }

        // First non-progress message is treated as the final result.
        finishOk(msg);
      });
      worker.once('error', finishErr);
      worker.once('exit', (code) => {
        if (done) return;
        if (code === 0) finishErr(new Error('Analysis worker exited without sending a result'));
        else finishErr(new Error(`Analysis worker exited with code ${code}`));
      });
    }).catch(() => {
      reject(new Error(`Analysis worker not found: ${workerPath}. Run: npm run build`));
    });
  });
}

// Persisted ROM folder scan cache.
const ROM_FOLDER_CACHE_VERSION = 6;
const ROM_FOLDER_CACHE_FILE = 'romFolderCache.json';
let romFolderCache = null;
let romFolderCacheLoadPromise = null;

async function loadRomFolderCache() {
  try {
    const userDataDir = app.getPath('userData');
    const filePath = path.join(userDataDir, ROM_FOLDER_CACHE_FILE);
    const txt = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(txt);
    if (!data || !Array.isArray(data.items)) return null;

    let folderPaths = [];
    if (data.version === ROM_FOLDER_CACHE_VERSION) {
      folderPaths = normalizeFolderPaths(data.folderPaths);
    } else if (data.version === 5 && typeof data.folderPath === 'string') {
      folderPaths = normalizeFolderPaths([data.folderPath]);
    } else {
      return null;
    }

    if (!folderPaths.length) return null;

    return {
      version: ROM_FOLDER_CACHE_VERSION,
      folderPaths,
      selectionKey: getFolderSelectionKey(folderPaths),
      items: data.items,
      meta: data.meta && typeof data.meta === 'object' ? data.meta : null,
      savedAtMs: typeof data.savedAtMs === 'number' ? data.savedAtMs : null
    };
  } catch {
    return null;
  }
}

async function saveRomFolderCache(cache) {
  if (!cache) return;
  const folderPaths = normalizeFolderPaths(cache.folderPaths);
  if (!folderPaths.length) return;
  const userDataDir = app.getPath('userData');
  const filePath = path.join(userDataDir, ROM_FOLDER_CACHE_FILE);
  const payload = {
    version: ROM_FOLDER_CACHE_VERSION,
    folderPaths,
    items: cache.items || [],
    meta: cache.meta || null,
    savedAtMs: cache.savedAtMs || Date.now()
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function ensureRomFolderCacheLoaded() {
  if (!romFolderCacheLoadPromise) {
    romFolderCacheLoadPromise = (async () => {
      romFolderCache = await loadRomFolderCache();
      return romFolderCache;
    })();
  }
  return romFolderCacheLoadPromise;
}

async function terminateActiveWorker() {
  const w = activeWorker;
  if (!w) return;
  activeWorker = null;
  try {
    // terminate() returns a Promise in modern Node, but older versions may return void.
    const r = w.terminate();
    if (r && typeof r.then === 'function') await r;
  } catch {
    // Ignore termination failures.
  }
}

async function resolveStartupRomPath() {
  const recent = await getRecentRomPaths();
  for (const filepath of recent) {
    if (!filepath || typeof filepath !== 'string') continue;
    try {
      await fs.access(filepath);
      return filepath;
    } catch {
      // Ignore stale paths in the recent list.
    }
  }
  return null;
}


function serializeFlowForRenderer(flow) {
  if (!flow || typeof flow !== 'object') return null;
  const out = {
    type: typeof flow.type === 'string' ? flow.type : null
  };
  if (typeof flow.target === 'number') out.target = flow.target & 0xffff;
  if (typeof flow.fallthrough === 'number') out.fallthrough = flow.fallthrough & 0xffff;
  if (typeof flow.next === 'number') out.next = flow.next & 0xffff;
  if (typeof flow.targetRomOff === 'number') out.targetRomOff = flow.targetRomOff >>> 0;
  if (typeof flow.fallthroughRomOff === 'number') out.fallthroughRomOff = flow.fallthroughRomOff >>> 0;
  if (typeof flow.nextRomOff === 'number') out.nextRomOff = flow.nextRomOff >>> 0;
  return out;
}

function serializeLineForRenderer(ln) {
  if (!ln || typeof ln !== 'object') return null;
  return {
    backing: ln.backing || null,
    romOff: typeof ln.romOff === 'number' ? (ln.romOff >>> 0) : null,
    cpuAddr: typeof ln.cpuAddr === 'number' ? (ln.cpuAddr & 0xffff) : null,
    len: typeof ln.len === 'number' ? (ln.len >>> 0) : null,
    bytesText: typeof ln.bytesText === 'string' ? ln.bytesText : '',
    asm: typeof ln.asm === 'string' ? ln.asm : '',
    mnemonic: typeof ln.mnemonic === 'string' ? ln.mnemonic : '',
    mode: typeof ln.mode === 'string' ? ln.mode : null,
    flow: serializeFlowForRenderer(ln.flow)
  };
}

function serializeBlockForRenderer(block) {
  if (!block || typeof block !== 'object') return null;
  const { siteKey: _siteKey, ctxKey: _ctxKey, lines: _lines, ...rest } = block;
  return {
    ...rest,
    lines: Array.isArray(block.lines) ? block.lines.map(serializeLineForRenderer).filter(Boolean) : []
  };
}

function stripNavigationIdentityFields(value) {
  if (Array.isArray(value)) return value.map(stripNavigationIdentityFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'siteKey' || key === 'ctxKey' || key === 'fetchCtx') continue;
    if (key === 'rawBlockId' || key === 'siteRawBlockId') continue;
    if (key === 'anchorBlockId' || key === 'anchorRomOff' || key === 'anchorCpuAddr') continue;
    out[key] = stripNavigationIdentityFields(item);
  }
  return out;
}

function serializeUnresolvedSiteForRenderer(site) {
  if (!site || site.kind !== 'jmp_ind') return null;
  const romOff = typeof site.romOff === 'number' ? (site.romOff >>> 0) : null;
  if (romOff === null) return null;
  return {
    kind: 'jmp_ind',
    romOff,
    pc: typeof site.pc === 'number' ? (site.pc & 0xffff) : null,
    ptrAddr: typeof site.ptrAddr === 'number' ? (site.ptrAddr & 0xffff) : null
  };
}

export function registerAnalysisIpc() {
  async function openRomFromPath(filepath) {
    const buf = await fs.readFile(filepath);
    const ines = parseInes(buf);
    const vectors = readVectorsFromLastPrgBank(ines);

    // Whole-file hash for per-ROM user annotations (bookmarks, etc).
    const romHash = crypto.createHash('sha1').update(buf).digest('hex');
    const bookmarks = await getBookmarksForRomHash(romHash);
    const labels = await getLabelsForRomHash(romHash);
    const addrLabels = await getAddrLabelsForRomHash(romHash);

    // NesViz supports only one active ROM/analysis at a time.
    // When opening a new ROM, terminate any running analysis and discard prior state.
    await terminateActiveWorker();

    active = {
      filepath,
      filename: path.basename(filepath),
      romHash,
      ines,
      vectors,
      cdl: null,
      rawAnalysis: null,

      displayAnalysis: null,
      rawToDisplayBlockIds: null,
      blockById: null,
      heatmapCache: null
    };

    let hasCachedAnalysis = false;
    try {
      hasCachedAnalysis = await hasAnalysisCache(romHash);
    } catch (err) {
      console.warn('Analysis cache existence check failed while opening ROM; ignoring cached analysis:', err);
    }

    // Update recent ROMs (persisted in userData). This also refreshes the app menu.
    try {
      const recentRoms = await recordRecentRomPath(filepath, 10);
      updateRecentRoms(recentRoms);
    } catch {
      // Ignore recent list failures.
    }
    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyHeatmapDataChanged(); } catch {}
    try { notifyMarkovMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    return {
      ok: true,
      romHash,
      bookmarks,
      labels,
      addrLabels,
      rom: {
        filename: path.basename(filepath),
        mapperNumber: ines.mapperNumber,
        prgSize: ines.prg.length,
        chrSize: ines.chr.length
      },
      vectors,
      hasCachedAnalysis
    };
  }

  function isStaticAnalysisSupportedHeader(header) {
    return !!getStaticAnalysisInfoForHeader(header).isAnalyzable;
  }

  async function readInesHeaderOnly(filepath) {
    const fh = await fs.open(filepath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const { bytesRead } = await fh.read(buf, 0, 16, 0);
      if (bytesRead < 16) return null;

      let header;
      try {
        header = parseInesHeader(buf);
      } catch {
        return null;
      }

      const isNrom = header.mapperNumber === 0;
      const nromKind = isNrom
        ? (header.prgSize <= 16384 ? 'NROM-128' : 'NROM-256')
        : null;

      const analysisInfo = getStaticAnalysisInfoForHeader(header);

      return {
        mapperNumber: header.mapperNumber,
        submapperNumber: header.submapperNumber,
        mapperName: header.mapperName,
        prgBytes: header.prgSize,
        chrBytes: header.chrSize,
        hasTrainer: header.hasTrainer,
        isInes2: header.isNes2,
        isTargetMapper: header.isTargetMapper,
        isAnalyzable: !!analysisInfo.isAnalyzable,
        analysisKind: analysisInfo.analysisKind || null,
        nromKind,
        analysisMapper: header.analysisMapper
      };
    } finally {
      await fh.close();
    }
  }

  ipcMain.handle('nesviz:openRom', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open NES ROM',
      properties: ['openFile'],
      filters: [
        { name: 'NES ROM', extensions: ['nes'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const filepath = result.filePaths[0];
    return openRomFromPath(filepath);
  });

  ipcMain.handle('nesviz:openRomPath', async (_evt, { filepath }) => {
    if (!filepath) return { ok: false, error: 'No filepath provided' };
    return openRomFromPath(filepath);
  });

  ipcMain.handle('nesviz:loadActiveAnalysisCache', async () => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    let cachedResult;
    try {
      cachedResult = await loadAnalysisCache(s.romHash);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        clearActiveAnalysisState(s);
        try { notifyMemoryMapDataChanged(); } catch {}
        try { notifyHeatmapDataChanged(); } catch {}
    try { notifyMarkovMapDataChanged(); } catch {}
        try { notifyGraphDataChanged(); } catch {}
        return { ok: true, hasCachedAnalysis: false };
      }
      console.warn('Analysis cache load failed for active ROM:', err);
      return { ok: false, error: `Cached analysis load failed: ${err?.message || String(err)}` };
    }

    try {
      applyAnalysisResultToActiveState(s, cachedResult);
    } catch (err) {
      console.warn('Cached analysis payload was invalid for active ROM:', err);
      return { ok: false, error: `Cached analysis was invalid: ${err?.message || String(err)}` };
    }

    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyHeatmapDataChanged(); } catch {}
    try { notifyMarkovMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    return {
      ok: true,
      hasCachedAnalysis: true,
      stats: s.displayAnalysis?.stats || null
    };
  });

  ipcMain.handle('nesviz:getStartupRomPath', async () => {
    const filepath = await resolveStartupRomPath();
    return { ok: true, filepath };
  });

  ipcMain.handle('nesviz:getActiveLabels', async () => {
    const s = active;

    if (!s?.romHash) {
      return { ok: true, hasRom: false, labels: {}, addrLabels: {} };
    }

    const labels = await getLabelsForRomHash(s.romHash);
    const addrLabels = await getAddrLabelsForRomHash(s.romHash);
    return { ok: true, hasRom: true, romHash: s.romHash, labels, addrLabels };
  });

  ipcMain.handle('nesviz:setBookmarkAtRomOff', async (_evt, { romOff, set }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };
    const off = typeof romOff === 'number' ? romOff : Number(romOff);
    if (!Number.isFinite(off) || off < 0) return { ok: false, error: 'Invalid romOff' };

    const next = await setBookmarkForRomHash(s.romHash, off, !!set);
    return { ok: true, bookmarks: next };
  });

  ipcMain.handle('nesviz:setRomLabel', async (_evt, { romOff, label }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };
    const off = typeof romOff === 'number' ? romOff : Number(romOff);
    if (!Number.isFinite(off) || off < 0) return { ok: false, error: 'Invalid romOff' };

    const next = await setLabelForRomHash(s.romHash, off, label);
    return { ok: true, labels: next };
  });

  ipcMain.handle('nesviz:setAddrLabel', async (_evt, { cpuAddr, label }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    const a = typeof cpuAddr === 'number' ? cpuAddr : Number(cpuAddr);
    if (!Number.isFinite(a) || a < 0) return { ok: false, error: 'Invalid cpuAddr' };

    const next = await setAddrLabelForRomHash(s.romHash, a, label);
    return { ok: true, addrLabels: next };
  });

  ipcMain.handle('nesviz:selectRomFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select ROM Folders',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }
    const folderPaths = normalizeFolderPaths(result.filePaths);
    if (!folderPaths.length) return { ok: false, canceled: true };
    return { ok: true, folderPaths };
  });

  ipcMain.handle('nesviz:getRomFolderCache', async () => {
    await ensureRomFolderCacheLoaded();
    if (!romFolderCache || !Array.isArray(romFolderCache.folderPaths) || !romFolderCache.folderPaths.length) {
      return { ok: true, hasCache: false };
    }
    return {
      ok: true,
      hasCache: true,
      folderPaths: romFolderCache.folderPaths.slice(),
      items: Array.isArray(romFolderCache.items)
        ? romFolderCache.items.map((item) => decorateRomFolderItem(item))
        : [],
      meta: romFolderCache.meta || null,
      savedAtMs: romFolderCache.savedAtMs || null
    };
  });

  ipcMain.handle('nesviz:startRomFolderScan', async (evt, { folderPaths, force }) => {
    const normalizedFolderPaths = normalizeFolderPaths(folderPaths);
    if (!normalizedFolderPaths.length) return { ok: false, error: 'No folderPaths provided' };
    await ensureRomFolderCacheLoaded();

    const scanId = `fs${nextFolderScanId++}`;
    const wc = evt.sender;

    const selectionKey = getFolderSelectionKey(normalizedFolderPaths);
    const canUseCache = !force
      && romFolderCache
      && romFolderCache.selectionKey === selectionKey
      && Array.isArray(romFolderCache.items);

    function send(payload) {
      try {
        if (!wc || wc.isDestroyed()) return;
        wc.send('nesviz:romFolderScan', payload);
      } catch {
        // Ignore send failures.
      }
    }

    // Stream results in small batches to avoid huge single payloads.
    // Start on the next tick so the renderer can receive the scanId first.
    setTimeout(() => void (async () => {
      try {
        if (canUseCache) {
          const items = Array.isArray(romFolderCache.items)
            ? romFolderCache.items.map((item) => decorateRomFolderItem(item))
            : [];
          const meta = romFolderCache.meta || {};
          const totalCount = Number.isFinite(meta.totalCount) ? meta.totalCount : items.length;
          const scannedCount = Number.isFinite(meta.scannedCount) ? meta.scannedCount : totalCount;
          const foundCount = Number.isFinite(meta.foundCount) ? meta.foundCount : items.length;
          const errorCount = Number.isFinite(meta.errorCount) ? meta.errorCount : 0;

          send({ scanId, type: 'start', folderPaths: romFolderCache.folderPaths.slice(), totalCount });

          const batchSize = 50;
          for (let i = 0; i < items.length; i += batchSize) {
            const chunk = items.slice(i, i + batchSize);
            send({
              scanId,
              type: 'batch',
              items: chunk,
              scannedCount,
              totalCount,
              foundCount,
              errorCount
            });
          }

          send({ scanId, type: 'done', scannedCount, totalCount, foundCount, errorCount, cached: true });
          return;
        }

        let total = 0;
        let scanned = 0;
        let found = 0;
        let errors = 0;
        const batch = [];
        const allFound = [];
        const scanTargets = [];

        for (const folderPath of normalizedFolderPaths) {
          try {
            const entries = await fs.readdir(folderPath, { withFileTypes: true });
            const files = entries
              .filter((d) => d.isFile())
              .map((d) => d.name)
              .filter((name) => name.toLowerCase().endsWith('.nes'))
              .sort((a, b) => a.localeCompare(b));
            total += files.length;
            scanTargets.push({ folderPath, files });
          } catch {
            errors++;
          }
        }

        send({ scanId, type: 'start', folderPaths: normalizedFolderPaths.slice(), totalCount: total });

        for (const target of scanTargets) {
          const folderPath = target.folderPath;
          for (const name of target.files) {
            const fullPath = path.join(folderPath, name);
            scanned++;
            try {
              const h = await readInesHeaderOnly(fullPath);
              if (h && h.isTargetMapper) {
                found++;
                const item = toCachedRomFolderItem({
                  fullPath,
                  filename: name,
                  header: h,
                  nromKind: h.nromKind
                });
                allFound.push(item);
                batch.push(decorateRomFolderItem(item));
              }
            } catch {
              errors++;
            }

            if (batch.length >= 25) {
              send({
                scanId,
                type: 'batch',
                items: batch.splice(0, batch.length),
                scannedCount: scanned,
                totalCount: total,
                foundCount: found,
                errorCount: errors
              });
            }
          }
        }

        if (batch.length) {
          send({
            scanId,
            type: 'batch',
            items: batch.splice(0, batch.length),
            scannedCount: scanned,
            totalCount: total,
            foundCount: found,
            errorCount: errors
          });
        }

        send({ scanId, type: 'done', scannedCount: scanned, totalCount: total, foundCount: found, errorCount: errors });

        romFolderCache = {
          version: ROM_FOLDER_CACHE_VERSION,
          folderPaths: normalizedFolderPaths,
          selectionKey,
          items: allFound,
          meta: { scannedCount: scanned, totalCount: total, foundCount: found, errorCount: errors },
          savedAtMs: Date.now()
        };
        try {
          await saveRomFolderCache(romFolderCache);
        } catch {
          // Ignore persistence errors.
        }
      } catch (e) {
        send({ scanId, type: 'error', message: e?.message ?? String(e) });
      }
    })(), 0);

    return { ok: true, scanId, folderPaths: normalizedFolderPaths };
  });


  ipcMain.handle('nesviz:openCdl', async () => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };

    const result = await dialog.showOpenDialog({
      title: 'Open CDL (Code/Data Log)',
      properties: ['openFile'],
      filters: [
        { name: 'CDL', extensions: ['cdl'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const filepath = result.filePaths[0];
    const buf = await fs.readFile(filepath);

    const parsed = parseNesCdl(new Uint8Array(buf), {
      prgSize: s.ines.prg.length,
      chrSize: s.ines.chr.length
    });

    if (!parsed.ok) {
      return { ok: false, error: parsed.warnings?.[0] || 'Failed to parse CDL.' };
    }

    s.cdl = {
      filepath,
      filename: path.basename(filepath),
      format: parsed.format,
      rawLength: buf.length,
      prg: parsed.prg,
      chr: parsed.chr,
      warnings: parsed.warnings,
      header: parsed.header || null
    };

    // CDL is loaded and stored, but not applied until the user runs analysis. 🤖
    // Clear any previous analysis results so the user doesn't confuse the old view with the CDL-applied view. 🤖
    clearActiveAnalysisState(s);

    try {
      await invalidateAnalysisArtifacts(s.romHash);
    } catch (err) {
      console.warn('Analysis artifact invalidation failed after loading CDL:', err);
    }

    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyHeatmapDataChanged(); } catch {}
    try { notifyMarkovMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    return {
      ok: true,
      cdl: {
        filename: s.cdl.filename,
        format: s.cdl.format,
        rawLength: s.cdl.rawLength,
        prgBytes: s.cdl.prg ? s.cdl.prg.length : 0,
        chrBytes: s.cdl.chr ? s.cdl.chr.length : 0,
        warnings: s.cdl.warnings
      }
    };
  });

  ipcMain.handle('nesviz:runStaticAnalysis', async (evt) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    const m = s.ines.mapperNumber | 0;
    const prgSize = (s.ines?.prg?.length | 0) || 0;

    const analysisInfo = getStaticAnalysisInfoForHeader(s.ines);
    if (!analysisInfo.isAnalyzable) {
      return {
        ok: false,
        error: `Supported for static analysis: mapper 0 (NROM), mapper 1 (MMC1), mapper 2 (UxROM), mapper 4 (MMC3), mapper 94 (UN1ROM), CNROM (mappers 3 and 185), CPROM (13), AxROM (7), BNROM (34 BNROM only), and GxROM (66). ROM is mapper ${m} (PRG ${prgSize} bytes).`
      };
    }


    const mapperKind = analysisInfo.analysisKind;

    try {
      await invalidateAnalysisArtifacts(s.romHash);
    } catch (err) {
      console.warn('Analysis artifact invalidation failed before static analysis:', err);
    }

    await terminateActiveWorker();

    let workerResult;
    try {
      let thisWorker = null;

      workerResult = await runStaticAnalysisInWorker({
        prgBytes: s.ines.prg,
        vectors: s.vectors,
        mapperKind,
        mapperMeta: s.ines.analysisMapper || null,
        cdlPrg: s.cdl?.prg || null,
        cdlChr: s.cdl?.chr || null,
        cdlMeta: s.cdl ? { filename: s.cdl.filename, format: s.cdl.format, rawLength: s.cdl.rawLength, warnings: s.cdl.warnings } : null,
        tuningOverrides: { fixedSwitch16k: getTuningState(), mmc1: getTuningState() }
      }, {
        onWorker: (w) => {
          thisWorker = w;
          activeWorker = w;
        },
        onProgress: (msg) => {
          // Stream VSA progress to the renderer while analysis runs.
          try {
            evt.sender.send('nesviz:vsaProgress', {
              stableBlocks: msg?.stableBlocks,
              totalBlocks: msg?.totalBlocks,
              runId: msg?.runId
            });
          } catch {
            // Ignore send failures (window closed, etc).
          }
        }
      });

      // Only clear activeWorker if this run still owns it.
      if (activeWorker === thisWorker) activeWorker = null;
    } catch (err) {
      console.error('Static analysis worker failed:', err);
      return { ok: false, error: `Static analysis failed: ${err?.message || String(err)}` };
    }

    if (!workerResult?.ok) {
      const e = workerResult?.error || 'Static analysis failed';
      if (workerResult?.stack) console.error('Static analysis worker stack:', workerResult.stack);
      return { ok: false, error: e };
    }

    // If the user switched ROMs while analysis was running, discard these results.
    if (active !== s) return { ok: false, error: 'ROM changed during analysis' };

    applyAnalysisResultToActiveState(s, workerResult);

    try {
      await saveAnalysisCache(s.romHash, {
        rawAnalysis: s.rawAnalysis,
        displayAnalysis: s.displayAnalysis,
        rawToDisplayBlockIds: s.rawToDisplayBlockIds
      });
    } catch (err) {
      console.warn('Analysis cache save failed:', err);
    }

    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyHeatmapDataChanged(); } catch {}
    try { notifyMarkovMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    try {
      appendAnalysisLogLines(formatAnalysisLogLines({
        filename: s.filename,
        mapperKind: s.displayAnalysis?.mapper?.kind || mapperKind,
        analysis: s.displayAnalysis
      }));
    } catch {}

    return { ok: true, stats: s.displayAnalysis.stats };
  });

  ipcMain.handle('nesviz:getTimeline', async () => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };

    // Build an inbound-reference index for blocks. 🤖
    // We count only *explicit* control-flow references (branch/jump/call targets), not fallthroughs. 🤖
    // We also ignore self-loops (e.g., branch-to-self) to avoid reporting intra-block loops. 🤖
    const inboundByBlockId = buildInboundRefsByBlockId(s.displayAnalysis);

    const blocksIndex = s.displayAnalysis.blocks.map((b) => ({
      id: b.id,
      romStart: b.romStart,
      romEnd: b.romEnd,
      confidence: b.confidence,
      pills: Array.isArray(b.pills) ? b.pills : [],
      cpuStart: b.cpuStart ?? (b.lines?.[0]?.cpuAddr ?? null),
      cpuEnd: b.cpuEnd ?? null,
      inbound: {
        count: (inboundByBlockId.get(b.id) || []).length,
        sources: inboundByBlockId.get(b.id) || []
      },
      firstAsm: b.lines?.[0]?.asm || '',
      lineCount: b.lines?.length || 0,
      previewLines: (b.lines || []).slice(0, 8).map(serializeLineForRenderer).filter(Boolean)
    }));
    return {
      ok: true,
      timeline: s.displayAnalysis.timeline,
      blocksIndex,
      mapper: s.displayAnalysis.mapper,
      stats: s.displayAnalysis.stats,
      debug: null,
      vectorDestinationsByFamily: getVectorDestinationsByFamilyForActive(s)
    };
  });

  function buildInboundRefsByBlockId(analysis) {
    const romOffToBlockId = new Map();
    for (const b of analysis.blocks || []) {
      for (const ln of b.lines || []) {
        if (typeof ln?.romOff === 'number') romOffToBlockId.set(ln.romOff >>> 0, b.id);
      }
    }

    const inbound = new Map();

    for (const fromBlock of analysis.blocks || []) {
      for (const ln of fromBlock.lines || []) {
        const f = ln.flow;
        if (!f) continue;
        if (f.type !== 'branch' && f.type !== 'jump' && f.type !== 'call') continue;
        if (typeof f.targetRomOff !== 'number') continue;
        if (typeof ln.romOff !== 'number') continue;

        const toRomOff = f.targetRomOff >>> 0;
        const toBlockId = romOffToBlockId.get(toRomOff);
        if (!toBlockId || toBlockId === fromBlock.id) continue;

        let m = inbound.get(toBlockId);
        if (!m) {
          m = new Map();
          inbound.set(toBlockId, m);
        }

        const fromRomOff = ln.romOff >>> 0;
        const key = `rom:${fromRomOff}`;
        if (!m.has(key)) {
          m.set(key, {
            fromRomOff,
            fromCpuAddr: typeof ln.cpuAddr === 'number' ? (ln.cpuAddr & 0xffff) : null,
            toRomOff,
            toCpuAddr: typeof f.target === 'number' ? (f.target & 0xffff) : null
          });
        }
      }
    }

    const out = new Map();
    for (const [blockId, m] of inbound.entries()) {
      const arr = Array.from(m.values()).sort((a, b) => a.fromRomOff - b.fromRomOff);
      out.set(blockId, arr);
    }
    return out;
  }

  ipcMain.handle('nesviz:getBlock', async (_evt, { blockId }) => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    const b = s.blockById?.get(blockId) || s.displayAnalysis.blocks.find((x) => x.id === blockId);
    if (!b) return { ok: false, error: 'Display block not found' };
    return { ok: true, block: serializeBlockForRenderer(b) };
  });

  ipcMain.handle('nesviz:getBlockVsaDebug', async (_evt, { blockId }) => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    const b = s.blockById?.get(blockId) || s.displayAnalysis.blocks.find((x) => x.id === blockId);
    if (!b) return { ok: false, error: 'Display block not found' };
    const debug = buildVsaLineDebugForBlock({ block: b, observationsResult: s.displayAnalysis.vsaFacts || null });
    return { ok: true, debug };
  });

  ipcMain.handle('nesviz:getBlocks', async (_evt, { blockIds }) => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    if (!Array.isArray(blockIds)) return { ok: false, error: 'blockIds must be an array' };

    const byId = s.blockById || new Map(s.displayAnalysis.blocks.map((b) => [b.id, b]));
    const blocks = [];
    const missing = [];

    for (const id of blockIds) {
      if (!id) continue;
      const b = byId.get(id);
      if (b) blocks.push(b);
      else missing.push(id);
    }

    return { ok: true, blocks: blocks.map(serializeBlockForRenderer).filter(Boolean), missing };
  });

  ipcMain.handle('nesviz:getArtifacts', async () => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    return {
      ok: true,
      artifacts: (s.displayAnalysis.artifacts || []).map(stripNavigationIdentityFields),
      unresolvedSites: (s.displayAnalysis.unresolvedSites || []).map(serializeUnresolvedSiteForRenderer).filter(Boolean),
      pointsOfInterest: (s.displayAnalysis.pointsOfInterest || []).map(stripNavigationIdentityFields),
      // VSA facts pass output (no UI yet). Exposed here for easy debugging in the renderer console.
      vsaFacts: s.displayAnalysis.vsaFacts || null,
      mapper: s.displayAnalysis.mapper,
      stats: s.displayAnalysis.stats,
      rom: { filename: s.filename, mapperNumber: s.ines.mapperNumber, prgSize: s.ines.prg.length }
    };
  });

  ipcMain.handle('nesviz:getGraphData', async () => {
    const s = active;
    if (!s?.ines) {
      return {
        ok: true,
        hasRom: false,
        hasAnalysis: false,
        nodes: [],
        edges: [],
        rom: null,
        mapper: null,
        stats: null
      };
    }

    const graph = buildGraphData({
      rawAnalysis: s.rawAnalysis,
      displayAnalysis: s.displayAnalysis,
      rawToDisplayBlockIds: s.rawToDisplayBlockIds
    });

    return {
      ...graph,
      hasRom: true,
      rom: {
        filename: s.filename,
        mapperNumber: s.ines.mapperNumber,
        prgSize: s.ines.prg.length
      },
      mapper: s.displayAnalysis?.mapper || { kind: null, meta: s.ines.analysisMapper || null },
      stats: s.displayAnalysis?.stats || null
    };
  });

  ipcMain.handle('nesviz:getGraphLayoutCache', async () => {
    const s = active;
    if (!s?.romHash) return { ok: true, hasCache: false };
    try {
      const layout = await loadGraphLayoutCache(s.romHash);
      return { ok: true, hasCache: true, layout };
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: true, hasCache: false };
      console.warn('Graph layout cache load failed:', err);
      return { ok: false, error: `Graph layout cache load failed: ${err?.message || String(err)}` };
    }
  });

  ipcMain.handle('nesviz:saveGraphLayoutCache', async (_evt, payload) => {
    const s = active;
    if (!s?.romHash) return { ok: false, error: 'No active ROM' };
    try {
      const filePath = await saveGraphLayoutCache(s.romHash, payload || null);
      return { ok: true, filePath };
    } catch (err) {
      console.warn('Graph layout cache save failed:', err);
      return { ok: false, error: `Graph layout cache save failed: ${err?.message || String(err)}` };
    }
  });

  ipcMain.handle('nesviz:getMemoryMapData', async () => {
    return buildMemoryMapDataForActive();
  });

  ipcMain.handle('nesviz:getHeatmapData', async () => {
    return buildHeatmapDataForActive();
  });

  ipcMain.handle('nesviz:getMarkovMapData', async (_evt, payload) => {
    return buildMarkovMapDataForActive(payload || null);
  });

  ipcMain.handle('nesviz:getPrgBytes', async (_evt, { romStart, romEnd }) => {
    const s = active;
    if (!s?.ines?.prg) return { ok: false, error: 'No ROM loaded' };
    const start = Number(romStart);
    const endNum = Number(romEnd);
    if (!Number.isFinite(start) || !Number.isFinite(endNum)) return { ok: false, error: 'Invalid range' };
    const a = Math.max(0, Math.min(s.ines.prg.length, start | 0));
    const b = Math.max(a, Math.min(s.ines.prg.length, endNum | 0));
    return { ok: true, romStart: a, romEnd: b, bytes: Array.from(s.ines.prg.subarray(a, b)) };
  });
}

// Expose a minimal view of the currently loaded ROM so other main-process services
// (e.g. Trace Streamer) can show metadata without inventing a session concept.
export function getActiveRomSummary() {
  const s = active;
  if (!s) return null;
  const ines = s.ines;
  return {
    filepath: s.filepath,
    filename: s.filename,
    romHash: s.romHash,
    ines: ines
      ? {
          format: ines.format,
          mapperNumber: ines.mapperNumber,
          prgSize: ines.prgSize,
          chrSize: ines.chrSize,
          mirroring: ines.mirroring,
          hasTrainer: !!ines.hasTrainer,
          hasBattery: !!ines.hasBattery,
          fourScreen: !!ines.fourScreen
        }
      : null
  };
}
