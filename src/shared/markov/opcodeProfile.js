import {
  getCodeProfileFeatureNames,
  getCodeProfileFeatureVectorForBlock,
  classifySequenceLengthBucket,
  getCodeProfileLengthBuckets
} from './opcodeScoring.js';
import { shouldIncludeMarkovBlock, getInstructionCountForBlock } from './opcodeCorpus.js';
import { computeRobustScale, median } from '../utils/statsUtils.js';
import { addDiagonalRegularization, cloneMatrix, computeCovarianceMatrix, invertMatrix, makeIdentityMatrix } from '../utils/matrixUtils.js';

const MIN_SCALE = 1e-6;
const MIN_BUCKET_PROFILE_SAMPLE_COUNT = 64; // Bucket-local covariance needs much more support than 16 samples.

function buildFeatureRows(blocks, modelsByFamily, source) {
  const rows = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!shouldIncludeMarkovBlock(block, source)) continue;
    const vector = getCodeProfileFeatureVectorForBlock(block, modelsByFamily);
    if (!vector || vector.some((value) => !Number.isFinite(value))) continue;
    rows.push({
      vector,
      instructionCount: getInstructionCountForBlock(block)
    });
  }
  return rows;
}

function buildProfileFromFeatureVectors(featureVectors, featureNames) {
  const featureCount = Array.isArray(featureNames) ? featureNames.length : 0;
  const centers = Array.from({ length: featureCount }, () => 0);
  const scales = Array.from({ length: featureCount }, () => 1);

  for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
    const column = featureVectors.map((row) => row[featureIndex]);
    const center = median(column);
    centers[featureIndex] = center;
    scales[featureIndex] = computeRobustScale(column, center);
  }

  const standardizedRows = featureVectors.map((row) => (
    row.map((value, featureIndex) => (value - centers[featureIndex]) / scales[featureIndex])
  ));

  const covariance = computeCovarianceMatrix(standardizedRows);
  let inverseCovariance = null;
  let regularization = 0;
  for (const lambda of [0, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2]) {
    const candidate = lambda > 0 ? addDiagonalRegularization(covariance, lambda) : cloneMatrix(covariance);
    inverseCovariance = invertMatrix(candidate);
    if (inverseCovariance) {
      regularization = lambda;
      break;
    }
  }

  if (!inverseCovariance) {
    inverseCovariance = makeIdentityMatrix(featureCount);
    regularization = 1;
  }

  return {
    enabled: true,
    featureNames,
    robustCenter: centers,
    robustScale: scales,
    covariance,
    inverseCovariance,
    regularization,
    stats: {
      featureCount,
      sampleCount: featureVectors.length
    }
  };
}

export function trainCombinedCodeProfileFromBlocks(blocks, modelsByFamily, options = {}) {
  const source = options?.source === 'probablePlus' ? 'probablePlus' : 'confirmed';
  const featureNames = getCodeProfileFeatureNames();
  const rows = buildFeatureRows(blocks, modelsByFamily, source);
  const featureVectors = rows.map((row) => row.vector);
  const globalProfile = buildProfileFromFeatureVectors(featureVectors, featureNames);

  const bucketDefs = getCodeProfileLengthBuckets();
  const rowsByBucket = Object.fromEntries(bucketDefs.map((bucket) => [bucket.key, []]));
  for (const row of rows) {
    const bucketKey = classifySequenceLengthBucket(row.instructionCount);
    rowsByBucket[bucketKey].push(row.vector);
  }

  const profilesByLengthBucket = {};
  const bucketStats = {};
  for (const bucket of bucketDefs) {
    const bucketFeatureVectors = rowsByBucket[bucket.key] || [];
    const sampleCount = bucketFeatureVectors.length;
    const enabled = sampleCount >= MIN_BUCKET_PROFILE_SAMPLE_COUNT;
    profilesByLengthBucket[bucket.key] = enabled
      ? buildProfileFromFeatureVectors(bucketFeatureVectors, featureNames)
      : null;
    bucketStats[bucket.key] = {
      sampleCount,
      enabled,
      minInstructions: bucket.minInstructions,
      maxInstructions: Number.isFinite(bucket.maxInstructions) ? bucket.maxInstructions : null
    };
  }

  return {
    kind: 'combinedCodeProfile',
    corpus: source,
    trainedAtIso: new Date().toISOString(),
    families: ['opcode', 'addressing', 'mnemonic'],
    lengthBuckets: bucketDefs.map((bucket) => ({
      key: bucket.key,
      minInstructions: bucket.minInstructions,
      maxInstructions: Number.isFinite(bucket.maxInstructions) ? bucket.maxInstructions : null
    })),
    featureNames,
    globalProfile,
    profilesByLengthBucket,
    stats: {
      sampleCount: featureVectors.length,
      featureCount: featureNames.length,
      bucketStats
    }
  };
}

export function scoreFeatureVectorWithCodeProfile(featureVector, profileNode) {
  const vector = Array.isArray(featureVector) ? featureVector : [];
  const center = Array.isArray(profileNode?.robustCenter) ? profileNode.robustCenter : [];
  const scale = Array.isArray(profileNode?.robustScale) ? profileNode.robustScale : [];
  const invCov = Array.isArray(profileNode?.inverseCovariance) ? profileNode.inverseCovariance : [];
  if (!vector.length || vector.length !== center.length || vector.length !== scale.length || invCov.length !== vector.length) return null;

  const standardized = vector.map((value, index) => {
    const denom = Math.max(MIN_SCALE, Number(scale[index]) || 1);
    return ((Number(value) || 0) - (Number(center[index]) || 0)) / denom;
  });

  let squaredDistance = 0;
  for (let i = 0; i < standardized.length; i += 1) {
    let rowDot = 0;
    const row = Array.isArray(invCov[i]) ? invCov[i] : [];
    for (let j = 0; j < standardized.length; j += 1) {
      rowDot += (Number(row[j]) || 0) * standardized[j];
    }
    squaredDistance += standardized[i] * rowDot;
  }

  const safeSquaredDistance = Math.max(0, squaredDistance);
  return {
    featureCount: standardized.length,
    squaredDistance: safeSquaredDistance,
    distance: Math.sqrt(safeSquaredDistance),
    standardized
  };
}

export const scoreFeatureVectorWithOpcodeCodeProfile = scoreFeatureVectorWithCodeProfile;
