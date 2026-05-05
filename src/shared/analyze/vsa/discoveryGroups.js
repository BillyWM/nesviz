import { parseAddressKey } from '../../utils/addressUtils.js';
import { intersectNonEmpty } from '../../utils/setMathUtils.js';
import { uniqueSortedNumeric, uniqueSortedStrings } from '../../utils/uniqueUtils.js';

function groupMaxGap(space, kind) {
  if (space === 'zp') return 1;
  if (space === 'rom' && kind === 'romStreamAssociated') return 64;
  if (space === 'rom' && kind === 'romDataObserved') return 32;
  if (space === 'rom') return 16;
  if (kind === 'usedAsPointer') return 2;
  if (kind === 'oamFlowAssociated') return 16;
  return 8;
}

function buildClusterSeed(kind, fact) {
  return {
    kind,
    space: fact.space,
    memberAddressKeys: [fact.key],
    memberAddrs: [fact.addr],
    touchingFunctionIds: new Set((fact.allTouchingFunctionIds || fact.touchingFunctionIds || [])),
    touchingRawBlockIds: new Set((fact.allTouchingRawBlockIds || fact.touchingRawBlockIds || [])),
    traceIds: new Set((fact.allTraceIds || fact.traceIds || [])),
    pointerPairKeys: new Set(fact.pointerPairKeys || []),
    entryFamilies: new Set([...(fact.allReadInFamilies || fact.readInFamilies || []), ...(fact.writtenInFamilies || [])]),
    hardwareTargets: new Set((fact.allFlowsToIoAddrs || fact.flowsToIoAddrs || []))
  };
}

function mergeFactIntoCluster(cluster, fact) {
  cluster.memberAddressKeys.push(fact.key);
  cluster.memberAddrs.push(fact.addr);
  for (const value of (fact.allTouchingFunctionIds || fact.touchingFunctionIds || [])) cluster.touchingFunctionIds.add(value);
  for (const value of (fact.allTouchingRawBlockIds || fact.touchingRawBlockIds || [])) cluster.touchingRawBlockIds.add(value);
  for (const value of (fact.allTraceIds || fact.traceIds || [])) cluster.traceIds.add(value);
  for (const value of fact.pointerPairKeys || []) cluster.pointerPairKeys.add(value);
  for (const value of (fact.allReadInFamilies || fact.readInFamilies || [])) cluster.entryFamilies.add(value);
  for (const value of fact.writtenInFamilies || []) cluster.entryFamilies.add(value);
  for (const value of (fact.allFlowsToIoAddrs || fact.flowsToIoAddrs || [])) cluster.hardwareTargets.add(value);
}

function clusterCompatible(cluster, fact) {
  if (fact.addr === (cluster.memberAddrs[cluster.memberAddrs.length - 1] + 1)) return true;
  if (intersectNonEmpty(Array.from(cluster.traceIds), fact.allTraceIds || fact.traceIds || [])) return true;
  if (intersectNonEmpty(Array.from(cluster.pointerPairKeys), fact.pointerPairKeys || [])) return true;
  if (intersectNonEmpty(Array.from(cluster.touchingFunctionIds), fact.allTouchingFunctionIds || fact.touchingFunctionIds || [])) return true;
  if (intersectNonEmpty(Array.from(cluster.touchingRawBlockIds), fact.allTouchingRawBlockIds || fact.touchingRawBlockIds || [])) return true;
  if (intersectNonEmpty(Array.from(cluster.hardwareTargets), fact.allFlowsToIoAddrs || fact.flowsToIoAddrs || [])) return true;
  if (intersectNonEmpty(Array.from(cluster.entryFamilies), [...(fact.allReadInFamilies || fact.readInFamilies || []), ...(fact.writtenInFamilies || [])])) return true;
  return false;
}

function buildLocalClustersForKindSpace(kind, facts) {
  if (!facts.length) return [];
  const maxGap = groupMaxGap(facts[0].space, kind);
  const clusters = [];
  let cluster = buildClusterSeed(kind, facts[0]);

  for (let i = 1; i < facts.length; i++) {
    const fact = facts[i];
    const prevAddr = cluster.memberAddrs[cluster.memberAddrs.length - 1];
    const gap = fact.addr - prevAddr;
    if (gap > maxGap || !clusterCompatible(cluster, fact)) {
      clusters.push(cluster);
      cluster = buildClusterSeed(kind, fact);
      continue;
    }
    mergeFactIntoCluster(cluster, fact);
  }
  clusters.push(cluster);
  return clusters;
}

function clustersShouldMerge(a, b) {
  if (a.kind !== b.kind || a.space !== b.space) return false;
  if (intersectNonEmpty(Array.from(a.traceIds), Array.from(b.traceIds))) return true;
  if (intersectNonEmpty(Array.from(a.pointerPairKeys), Array.from(b.pointerPairKeys))) return true;
  if (intersectNonEmpty(Array.from(a.hardwareTargets), Array.from(b.hardwareTargets))) return true;
  if (intersectNonEmpty(Array.from(a.touchingFunctionIds), Array.from(b.touchingFunctionIds)) &&
      intersectNonEmpty(Array.from(a.entryFamilies), Array.from(b.entryFamilies))) return true;
  return false;
}

function mergeClusters(clusters) {
  const parent = clusters.map((_, index) => index);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function unite(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (clustersShouldMerge(clusters[i], clusters[j])) unite(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i);
    let acc = byRoot.get(root);
    if (!acc) {
      const base = clusters[root];
      acc = {
        kind: base.kind,
        space: base.space,
        memberAddressKeys: [],
        memberAddrs: [],
        touchingFunctionIds: new Set(),
        touchingRawBlockIds: new Set(),
        traceIds: new Set(),
        pointerPairKeys: new Set(),
        entryFamilies: new Set(),
        hardwareTargets: new Set()
      };
      byRoot.set(root, acc);
    }
    const source = clusters[i];
    for (const key of source.memberAddressKeys) acc.memberAddressKeys.push(key);
    for (const addr of source.memberAddrs) acc.memberAddrs.push(addr);
    for (const value of source.touchingFunctionIds) acc.touchingFunctionIds.add(value);
    for (const value of source.touchingRawBlockIds) acc.touchingRawBlockIds.add(value);
    for (const value of source.traceIds) acc.traceIds.add(value);
    for (const value of source.pointerPairKeys) acc.pointerPairKeys.add(value);
    for (const value of source.entryFamilies) acc.entryFamilies.add(value);
    for (const value of source.hardwareTargets) acc.hardwareTargets.add(value);
  }

  return Array.from(byRoot.values());
}

function buildSpans(addrs) {
  const sorted = uniqueSortedNumeric(addrs);
  if (!sorted.length) return [];
  const spans = [];
  let start = sorted[0];
  let end = sorted[0];
  let memberCount = 1;
  for (let i = 1; i < sorted.length; i++) {
    const addr = sorted[i];
    if (addr === end + 1) {
      end = addr;
      memberCount++;
      continue;
    }
    spans.push({ start, end, memberCount, byteLength: (end - start) + 1 });
    start = end = addr;
    memberCount = 1;
  }
  spans.push({ start, end, memberCount, byteLength: (end - start) + 1 });
  return spans;
}

function toGroup(groupId, cluster, factsByKey) {
  const memberAddressKeys = uniqueSortedStrings(cluster.memberAddressKeys);
  const memberAddrs = uniqueSortedNumeric(cluster.memberAddrs);
  const spans = buildSpans(memberAddrs);
  let readObservationCount = 0;
  let writeObservationCount = 0;
  for (const key of memberAddressKeys) {
    const fact = factsByKey[key];
    if (!fact) continue;
    readObservationCount += (fact.readObservationIds?.length || 0);
    writeObservationCount += (fact.writeObservationIds?.length || 0);
  }
  return {
    id: groupId,
    kind: cluster.kind,
    space: cluster.space,
    memberAddressKeys,
    memberAddrs,
    spans,
    touchingFunctionIds: uniqueSortedStrings(Array.from(cluster.touchingFunctionIds)),
    touchingRawBlockIds: uniqueSortedStrings(Array.from(cluster.touchingRawBlockIds)),
    entryFamilies: uniqueSortedStrings(Array.from(cluster.entryFamilies)),
    traceIds: uniqueSortedStrings(Array.from(cluster.traceIds)),
    pointerPairKeys: uniqueSortedStrings(Array.from(cluster.pointerPairKeys)),
    hardwareTargets: uniqueSortedNumeric(Array.from(cluster.hardwareTargets)),
    evidenceSummary: {
      memberAddressCount: memberAddressKeys.length,
      spanCount: spans.length,
      touchingFunctionCount: cluster.touchingFunctionIds.size,
      touchingRawBlockCount: cluster.touchingRawBlockIds.size,
      traceCount: cluster.traceIds.size,
      pointerPairCount: cluster.pointerPairKeys.size,
      hardwareTargetCount: cluster.hardwareTargets.size,
      readObservationCount,
      writeObservationCount
    }
  };
}

export function buildDiscoveryGroups({ addressFacts, groupMembership }) {
  const factsByKey = addressFacts?.addressFactsByKey || {};
  const addressKeysByKind = groupMembership?.addressKeysByKind || {};
  const groups = [];
  let groupSeq = 0;

  for (const [kind, keys] of Object.entries(addressKeysByKind)) {
    const factsBySpace = new Map();
    for (const key of keys) {
      const fact = factsByKey[key];
      if (!fact) continue;
      const parsed = parseAddressKey(key);
      if (!parsed) continue;
      let list = factsBySpace.get(parsed.space);
      if (!list) {
        list = [];
        factsBySpace.set(parsed.space, list);
      }
      list.push(fact);
    }

    for (const [space, facts] of factsBySpace.entries()) {
      facts.sort((a, b) => a.addr - b.addr);
      const localClusters = buildLocalClustersForKindSpace(kind, facts);
      const mergedClusters = mergeClusters(localClusters);
      for (const cluster of mergedClusters) {
        groupSeq++;
        groups.push(toGroup(`group:${kind}:${space}:${groupSeq}`, cluster, factsByKey));
      }
    }
  }

  groups.sort((a, b) => {
    if (a.space !== b.space) return a.space.localeCompare(b.space);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    const aStart = a.spans[0]?.start ?? 0;
    const bStart = b.spans[0]?.start ?? 0;
    return aStart - bStart;
  });

  return {
    version: 1,
    groups,
    stats: {
      groupCount: groups.length,
      groupCountsByKind: groups.reduce((acc, group) => {
        acc[group.kind] = (acc[group.kind] || 0) + 1;
        return acc;
      }, {})
    }
  };
}
