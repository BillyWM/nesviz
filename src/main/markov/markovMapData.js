import { loadMarkovModel, loadCombinedCodeProfile } from './markovStore.js';
import { scoreBlockWithMarkovModel, scoreBlockWithCombinedCodeProfile } from '../../shared/analyze/markov/opcodeScoring.js';
import { scoreFeatureVectorWithCodeProfile } from '../../shared/analyze/markov/opcodeProfile.js';
import { percentile } from '../../shared/utils/statsUtils.js';
import { getPrgRegionSizeBytes } from '../utils/prgRegionUtils.js';

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

export async function buildMarkovMapDataForState(activeState, payload) {
  const s = activeState || null;
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
