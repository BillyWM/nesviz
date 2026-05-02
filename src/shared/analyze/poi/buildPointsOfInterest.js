import { collectPointsOfInterestFromBlockRecognizers } from './fromBlockRecognizers.js';
import { collectPointsOfInterestFromVsa } from './fromVSA.js';
import { collectPointsOfInterestFromMonotoneTables } from './fromMonotoneTables.js';

function addPill(block, pill) {
  if (!block || !pill) return;
  if (!Array.isArray(block.pills)) block.pills = [];
  if (!block.pills.includes(pill)) block.pills.push(pill);
}

function mergePillsByBlockId(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [blockId, pills] of Object.entries(source)) {
    if (typeof blockId !== 'string' || !blockId) continue;
    if (!Array.isArray(pills) || !pills.length) continue;
    if (!target[blockId]) target[blockId] = [];
    for (const pill of pills) {
      if (!pill || target[blockId].includes(pill)) continue;
      target[blockId].push(pill);
    }
  }
}

function normalizeRomSpan(poi) {
  const span = poi?.basis?.romOffSpan;
  if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end)) return null;
  const start = span.start >>> 0;
  const end = span.end >>> 0;
  if (end < start) return null;
  return { start, end };
}

function poiVisibleKey(poi) {
  if (!poi || typeof poi !== 'object') return null;
  const kind = typeof poi.kind === 'string' && poi.kind ? poi.kind : 'unknown';
  const span = normalizeRomSpan(poi);
  if (span) return `${kind}:rom:${span.start}:${span.end}`;
  return null;
}

function stableValueKey(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return `${type}:${String(value)}`;
  try {
    return `${type}:${JSON.stringify(value)}`;
  } catch {
    return `${type}:${String(value)}`;
  }
}

function appendUnique(target, values) {
  if (!Array.isArray(target) || !Array.isArray(values)) return target;
  const seen = new Set(target.map(stableValueKey));
  for (const value of values) {
    const key = stableValueKey(value);
    if (seen.has(key)) continue;
    target.push(value);
    seen.add(key);
  }
  return target;
}

function mergePoiMeta(target, duplicate) {
  if (!target || !duplicate) return;
  if (!Array.isArray(target.mergedPoiIds)) target.mergedPoiIds = [];
  appendUnique(target.mergedPoiIds, [target.id, duplicate.id].filter((id) => typeof id === 'string' && id));

  if (!target.meta || typeof target.meta !== 'object') target.meta = {};
  if (!Array.isArray(target.meta.mergedCandidates)) target.meta.mergedCandidates = [];

  const candidate = {
    id: typeof duplicate.id === 'string' ? duplicate.id : null,
    kind: typeof duplicate.kind === 'string' ? duplicate.kind : null,
    basis: duplicate.basis && typeof duplicate.basis === 'object' ? { ...duplicate.basis } : null,
    meta: duplicate.meta && typeof duplicate.meta === 'object' ? { ...duplicate.meta } : null
  };
  appendUnique(target.meta.mergedCandidates, [candidate]);
}

function dedupePointsOfInterest(pointsOfInterest) {
  const out = [];
  const byKey = new Map();
  for (const poi of pointsOfInterest || []) {
    if (!poi || typeof poi !== 'object') continue;
    const key = poiVisibleKey(poi);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      mergePoiMeta(existing, poi);
      continue;
    }
    byKey.set(key, poi);
    out.push(poi);
  }
  return out;
}

export function buildPointsOfInterest(analysis) {
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const blockById = new Map(blocks.filter((block) => typeof block?.id === 'string' && block.id).map((block) => [block.id, block]));
  const sources = [
    collectPointsOfInterestFromBlockRecognizers,
    collectPointsOfInterestFromVsa,
    collectPointsOfInterestFromMonotoneTables
  ];

  const allPois = [];
  const pillsByBlockId = {};

  for (const source of sources) {
    const result = source?.(analysis) || {};
    if (Array.isArray(result.pointsOfInterest)) allPois.push(...result.pointsOfInterest);
    mergePillsByBlockId(pillsByBlockId, result.pillsByBlockId);
  }

  const pointsOfInterest = dedupePointsOfInterest(allPois);

  for (const [blockId, pills] of Object.entries(pillsByBlockId)) {
    const block = blockById.get(blockId);
    if (!block) continue;
    for (const pill of pills) addPill(block, pill);
  }

  analysis.pointsOfInterest = pointsOfInterest;
  return { pointsOfInterest, pillsByBlockId };
}
