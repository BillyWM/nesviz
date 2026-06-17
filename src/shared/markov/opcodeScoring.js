import {
  getMarkovSequenceForBlock,
  getInstructionCountForBlock,
  getMemoryScalarFeaturesForBlock
} from './opcodeCorpus.js';

const CONTROL_FLOW_MNEMONICS = new Set(['JSR', 'JMP', 'RTS', 'RTI', 'BRK']);

const MAX_HISTORY_LENGTH = 5;
const LENGTH_BUCKETS = [
  { key: '1-3', minInstructions: 1, maxInstructions: 3 },
  { key: '4-7', minInstructions: 4, maxInstructions: 7 },
  { key: '8-15', minInstructions: 8, maxInstructions: 15 },
  { key: '16-31', minInstructions: 16, maxInstructions: 31 },
  { key: '32+', minInstructions: 32, maxInstructions: Infinity }
];
const MARKOV_FAMILIES = ['opcode', 'addressing', 'mnemonic'];

export function getMarkovFamilies() {
  return MARKOV_FAMILIES.slice();
}

export function getCodeProfileLengthBuckets() {
  return LENGTH_BUCKETS.map((bucket) => ({ ...bucket }));
}

export function classifySequenceLengthBucket(sequenceOrInstructionCount) {
  const instructionCount = Array.isArray(sequenceOrInstructionCount)
    ? sequenceOrInstructionCount.length
    : Math.max(0, Number(sequenceOrInstructionCount) || 0);
  for (const bucket of LENGTH_BUCKETS) {
    if (instructionCount >= bucket.minInstructions && instructionCount <= bucket.maxInstructions) return bucket.key;
  }
  return LENGTH_BUCKETS[LENGTH_BUCKETS.length - 1].key;
}

function tokenKey(token, family = 'opcode') {
  if (family === 'opcode') {
    return (Number(token) & 0xff).toString(16).toUpperCase().padStart(2, '0');
  }
  return String(token);
}

function historyKey(sequence, family) {
  return sequence.map((token) => tokenKey(token, family)).join(' ');
}

function sumRow(row) {
  let total = 0;
  if (!row || typeof row !== 'object') return total;
  for (const value of Object.values(row)) total += Number(value) || 0;
  return total;
}

function totalTokenCount(model) {
  const counts = model?.tokenCounts && typeof model.tokenCounts === 'object' ? model.tokenCounts : {};
  let total = 0;
  for (const value of Object.values(counts)) total += Number(value) || 0;
  return total;
}

function getStartRow(model) {
  return model?.startsByHistoryLength?.['1'] || null;
}

function getStartTotal(model) {
  const bucketStats = model?.bucketStats?.['1'];
  const fromStats = Number(bucketStats?.startEventCount);
  if (Number.isFinite(fromStats) && fromStats > 0) return fromStats;
  return sumRow(getStartRow(model));
}

function getVocabularySize(model) {
  const counts = model?.tokenCounts && typeof model.tokenCounts === 'object' ? model.tokenCounts : {};
  return Math.max(1, Object.keys(counts).length);
}

function getSmoothedProbability(count, total, vocabSize) {
  return ((count || 0) + 1) / ((total || 0) + Math.max(1, vocabSize));
}

function resolveTransitionRow(model, sequence, nextIndex, order, family) {
  const transitions = model?.transitionsByHistoryLength || {};
  const maxDesired = Math.max(1, Math.min(MAX_HISTORY_LENGTH, order | 0, nextIndex | 0));
  const nextTokenName = tokenKey(sequence[nextIndex], family);

  for (let historyLength = maxDesired; historyLength >= 1; historyLength -= 1) {
    const bucket = transitions[String(historyLength)] || null;
    const key = historyKey(sequence.slice(nextIndex - historyLength, nextIndex), family);
    const row = bucket?.[key] || null;
    if (!row) continue;
    return {
      usedHistoryLength: historyLength,
      exactHistoryLength: maxDesired,
      row,
      rowTotal: sumRow(row),
      nextTokenName,
      count: Number(row[nextTokenName]) || 0,
      observedAtRequestedHistory: historyLength === maxDesired && (Number(row[nextTokenName]) || 0) > 0,
      hadRequestedHistoryRow: historyLength === maxDesired
    };
  }

  const counts = model?.tokenCounts && typeof model.tokenCounts === 'object' ? model.tokenCounts : {};
  return {
    usedHistoryLength: 0,
    exactHistoryLength: maxDesired,
    row: null,
    rowTotal: totalTokenCount(model),
    nextTokenName,
    count: Number(counts[nextTokenName]) || 0,
    observedAtRequestedHistory: false,
    hadRequestedHistoryRow: false
  };
}

export function scoreSequenceWithMarkovModel(sequence, model, order = 1, family = 'opcode') {
  const safeFamily = family === 'mnemonic' ? 'mnemonic' : (family === 'addressing' ? 'addressing' : 'opcode');
  const safeSequence = Array.isArray(sequence) ? sequence.filter((token) => token !== null && token !== undefined) : [];
  const safeOrder = Math.max(1, Math.min(MAX_HISTORY_LENGTH, Number(order) || 1));
  if (!safeSequence.length || !model || typeof model !== 'object') return null;

  const startRow = getStartRow(model) || {};
  const startTotal = getStartTotal(model) || totalTokenCount(model) || 1;
  const vocabSize = getVocabularySize(model);
  const firstTokenKey = tokenKey(safeSequence[0], safeFamily);
  const firstCount = Number(startRow[firstTokenKey]) || 0;
  let logLikelihood = Math.log(getSmoothedProbability(firstCount, startTotal, vocabSize));

  let unseenTransitionCount = 0;
  let backedOffTransitionCount = 0;
  let missingHistoryCount = 0;
  const transitionCount = Math.max(0, safeSequence.length - 1);

  for (let nextIndex = 1; nextIndex < safeSequence.length; nextIndex += 1) {
    const resolved = resolveTransitionRow(model, safeSequence, nextIndex, safeOrder, safeFamily);
    const prob = getSmoothedProbability(resolved.count, resolved.rowTotal || totalTokenCount(model) || 1, vocabSize);
    logLikelihood += Math.log(prob);

    const exactHistoryLength = resolved.exactHistoryLength | 0;
    const usedHistoryLength = resolved.usedHistoryLength | 0;
    if (usedHistoryLength < exactHistoryLength) backedOffTransitionCount += 1;
    if (!resolved.hadRequestedHistoryRow) missingHistoryCount += 1;
    if (!resolved.observedAtRequestedHistory) unseenTransitionCount += 1;
  }

  const tokenCount = safeSequence.length;
  const avgLogLikelihood = logLikelihood / tokenCount;
  const crossEntropyBits = (-logLikelihood / Math.LN2) / tokenCount;
  const perplexity = 2 ** crossEntropyBits;

  return {
    family: safeFamily,
    order: safeOrder,
    tokenCount,
    transitionCount,
    logLikelihood,
    avgLogLikelihood,
    crossEntropyBits,
    perplexity,
    unseenTransitionCount,
    unseenTransitionRatio: transitionCount > 0 ? (unseenTransitionCount / transitionCount) : 0,
    backedOffTransitionCount,
    backedOffTransitionRatio: transitionCount > 0 ? (backedOffTransitionCount / transitionCount) : 0,
    missingHistoryCount,
    missingHistoryRatio: transitionCount > 0 ? (missingHistoryCount / transitionCount) : 0
  };
}

export function scoreBlockWithMarkovModel(block, model, order = 1, family = 'opcode') {
  const safeFamily = family === 'mnemonic' ? 'mnemonic' : (family === 'addressing' ? 'addressing' : 'opcode');
  const sequence = getMarkovSequenceForBlock(block, safeFamily);
  const metrics = scoreSequenceWithMarkovModel(sequence, model, order, safeFamily);
  if (!metrics) return null;
  return {
    rawBlockId: String(block?.id || ''),
    romStart: Number(block?.romStart),
    romEnd: Number(block?.romEnd),
    confidence: block?.confidence === 'probable' ? 'probable' : 'certain',
    metrics
  };
}

export function getCodeProfileFeatureNames(families = MARKOV_FAMILIES) {
  const names = [];
  for (const family of families) {
    for (let order = 1; order <= MAX_HISTORY_LENGTH; order += 1) {
      names.push(`${family}.avgLogLikelihood.${order}`);
    }
    for (let order = 1; order <= MAX_HISTORY_LENGTH; order += 1) {
      names.push(`${family}.unseenTransitionRatio.${order}`);
    }
  }
  names.push('scalar.controlFlowFraction');
  names.push('scalar.branchFraction');
  names.push('scalar.callFraction');
  names.push('scalar.zeroPageAccessFraction');
  names.push('scalar.ramAccessFraction');
  names.push('scalar.ioAccessFraction');
  names.push('scalar.mapperRomAccessFraction');
  names.push('scalar.indirectAccessFraction');
  return names;
}

function getFeatureVectorForSequence(sequence, model, family) {
  const safeSequence = Array.isArray(sequence) ? sequence : [];
  if (!safeSequence.length || !model || typeof model !== 'object') return null;
  const metricsByOrder = [];
  for (let order = 1; order <= MAX_HISTORY_LENGTH; order += 1) {
    const metrics = scoreSequenceWithMarkovModel(safeSequence, model, order, family);
    if (!metrics) return null;
    metricsByOrder.push(metrics);
  }
  const features = [];
  for (const metrics of metricsByOrder) features.push(metrics.avgLogLikelihood);
  for (const metrics of metricsByOrder) features.push(metrics.unseenTransitionRatio);
  return features;
}

function getInstructionLinesForBlock(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  return lines.filter((line) => Array.isArray(line?.bytes) && line.bytes.length > 0);
}

function getControlFlowScalarFeaturesForBlock(block) {
  const lines = getInstructionLinesForBlock(block);
  const instructionCount = lines.length;
  if (!instructionCount) {
    return [0, 0, 0];
  }

  let controlFlowCount = 0;
  let branchCount = 0;
  let callCount = 0;

  for (const line of lines) {
    const mnemonic = typeof line?.mnemonic === 'string' ? line.mnemonic.trim().toUpperCase() : '';
    const flowType = typeof line?.flow?.type === 'string' ? line.flow.type : '';
    const isBranch = flowType === 'branch';
    const isCall = mnemonic === 'JSR' || flowType === 'call';
    const isOtherControlFlow = CONTROL_FLOW_MNEMONICS.has(mnemonic);
    if (isBranch || isCall || isOtherControlFlow) {
      controlFlowCount += 1;
    }
    if (isBranch) {
      branchCount += 1;
    }
    if (isCall) {
      callCount += 1;
    }
  }

  return [
    controlFlowCount / instructionCount,
    branchCount / instructionCount,
    callCount / instructionCount
  ];
}

export function getCodeProfileFeatureVectorForBlock(block, modelsByFamily, families = MARKOV_FAMILIES) {
  const features = [];
  for (const family of families) {
    const model = modelsByFamily?.[family] || null;
    const sequence = getMarkovSequenceForBlock(block, family);
    const familyFeatures = getFeatureVectorForSequence(sequence, model, family);
    if (!familyFeatures) return null;
    features.push(...familyFeatures);
  }
  features.push(...getControlFlowScalarFeaturesForBlock(block));
  const memoryScalars = getMemoryScalarFeaturesForBlock(block);
  features.push(
    memoryScalars.zeroPageAccessFraction,
    memoryScalars.ramAccessFraction,
    memoryScalars.ioAccessFraction,
    memoryScalars.mapperRomAccessFraction,
    memoryScalars.indirectAccessFraction
  );
  return features;
}

function resolveProfileBucketForBlock(block, profile) {
  const instructionCount = getInstructionCountForBlock(block);
  const bucketKey = classifySequenceLengthBucket(instructionCount);
  const bucketProfile = profile?.profilesByLengthBucket?.[bucketKey] || null;
  return {
    bucketKey,
    instructionCount,
    selectedProfile: bucketProfile?.enabled ? bucketProfile : null
  };
}

export function scoreBlockWithCombinedCodeProfile(block, modelsByFamily, profile, scoreFeatureVectorWithCodeProfile) {
  const featureVector = getCodeProfileFeatureVectorForBlock(block, modelsByFamily);
  if (!featureVector || typeof scoreFeatureVectorWithCodeProfile !== 'function') return null;
  const { bucketKey, instructionCount, selectedProfile } = resolveProfileBucketForBlock(block, profile);
  if (!selectedProfile) return null;
  const profileScore = scoreFeatureVectorWithCodeProfile(featureVector, selectedProfile);
  if (!profileScore) return null;
  return {
    rawBlockId: String(block?.id || ''),
    romStart: Number(block?.romStart),
    romEnd: Number(block?.romEnd),
    confidence: block?.confidence === 'probable' ? 'probable' : 'certain',
    metrics: {
      ...profileScore,
      bucketKey,
      instructionCount,
      profileSampleCount: Number(selectedProfile?.stats?.sampleCount) || 0
    }
  };
}
