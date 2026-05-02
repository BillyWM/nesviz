import { collectMarkovSequencesFromBlocks } from './opcodeCorpus.js';

const MAX_HISTORY_LENGTH = 5;

function tokenKey(token, family = 'opcode') {
  if (family === 'opcode') {
    return (Number(token) & 0xff).toString(16).toUpperCase().padStart(2, '0');
  }
  return String(token);
}

function historyKey(sequence, family) {
  return sequence.map((token) => tokenKey(token, family)).join(' ');
}

function ensureBucketCounter(table, key) {
  table[key] = (table[key] || 0) + 1;
}

function ensureTransitionRow(table, key) {
  let row = table[key];
  if (!row) {
    row = {};
    table[key] = row;
  }
  return row;
}

function makeBucketMaps() {
  const buckets = {};
  for (let historyLength = 1; historyLength <= MAX_HISTORY_LENGTH; historyLength += 1) {
    buckets[String(historyLength)] = {};
  }
  return buckets;
}

function makeBucketStats() {
  const stats = {};
  for (let historyLength = 1; historyLength <= MAX_HISTORY_LENGTH; historyLength += 1) {
    stats[String(historyLength)] = {
      startCount: 0,
      startEventCount: 0,
      historyCount: 0,
      transitionEventCount: 0
    };
  }
  return stats;
}

export function trainMarkovModelFromBlocks(blocks, options = {}) {
  const source = options?.source === 'probablePlus' ? 'probablePlus' : 'confirmed';
  const family = options?.family === 'mnemonic' ? 'mnemonic' : (options?.family === 'addressing' ? 'addressing' : 'opcode');
  const { sequences, usedBlockCount, usedInstructionCount } = collectMarkovSequencesFromBlocks(blocks, source, family);

  const tokenCounts = {};
  const startsByHistoryLength = makeBucketMaps();
  const transitionsByHistoryLength = makeBucketMaps();
  const bucketStats = makeBucketStats();

  for (const sequence of sequences) {
    if (!sequence.length) continue;

    for (let i = 0; i < sequence.length; i += 1) {
      const key = tokenKey(sequence[i], family);
      tokenCounts[key] = (tokenCounts[key] || 0) + 1;
    }

    const maxStartHistory = Math.min(MAX_HISTORY_LENGTH, sequence.length);
    for (let historyLength = 1; historyLength <= maxStartHistory; historyLength += 1) {
      const key = historyKey(sequence.slice(0, historyLength), family);
      const bucketKey = String(historyLength);
      ensureBucketCounter(startsByHistoryLength[bucketKey], key);
      bucketStats[bucketKey].startEventCount += 1;
    }

    for (let nextIndex = 1; nextIndex < sequence.length; nextIndex += 1) {
      const nextTokenKey = tokenKey(sequence[nextIndex], family);
      const maxHistory = Math.min(MAX_HISTORY_LENGTH, nextIndex);
      for (let historyLength = 1; historyLength <= maxHistory; historyLength += 1) {
        const bucketKey = String(historyLength);
        const key = historyKey(sequence.slice(nextIndex - historyLength, nextIndex), family);
        const row = ensureTransitionRow(transitionsByHistoryLength[bucketKey], key);
        row[nextTokenKey] = (row[nextTokenKey] || 0) + 1;
        bucketStats[bucketKey].transitionEventCount += 1;
      }
    }
  }

  for (let historyLength = 1; historyLength <= MAX_HISTORY_LENGTH; historyLength += 1) {
    const bucketKey = String(historyLength);
    bucketStats[bucketKey].startCount = Object.keys(startsByHistoryLength[bucketKey]).length;
    bucketStats[bucketKey].historyCount = Object.keys(transitionsByHistoryLength[bucketKey]).length;
  }

  return {
    kind: `${family}Markov`,
    family,
    corpus: source,
    trainedAtIso: new Date().toISOString(),
    stats: {
      sequenceCount: sequences.length,
      usedBlockCount,
      usedInstructionCount
    },
    bucketStats,
    tokenCounts,
    startsByHistoryLength,
    transitionsByHistoryLength
  };
}

export function trainOpcodeMarkovModelFromBlocks(blocks, options = {}) {
  return trainMarkovModelFromBlocks(blocks, { ...options, family: 'opcode' });
}

export function trainMnemonicMarkovModelFromBlocks(blocks, options = {}) {
  return trainMarkovModelFromBlocks(blocks, { ...options, family: 'mnemonic' });
}

export function trainAddressingMarkovModelFromBlocks(blocks, options = {}) {
  return trainMarkovModelFromBlocks(blocks, { ...options, family: 'addressing' });
}
