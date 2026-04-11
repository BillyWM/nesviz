const DEFAULT_TRACE_IO_ADDRS = [
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x4014
];

const IO_ADDR_NAMES = {
  0x2000: 'PPUCTRL',
  0x2001: 'PPUMASK',
  0x2002: 'PPUSTATUS',
  0x2003: 'OAMADDR',
  0x2004: 'OAMDATA',
  0x2005: 'PPUSCROLL',
  0x2006: 'PPUADDR',
  0x2007: 'PPUDATA',
  0x4014: 'OAMDMA'
};

function fmtHex(v, width = 4) {
  return `$${(v >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function ioName(addr) {
  return IO_ADDR_NAMES[addr & 0xffff] || `IO ${fmtHex(addr & 0xffff)}`;
}

function observationIdOf(obs, index) {
  if (obs && (typeof obs.id === 'string' || typeof obs.id === 'number')) return String(obs.id);
  return `obs:${index + 1}`;
}

function memKey(space, addr) {
  return `${space}:${space === 'rom' ? (addr >>> 0) : (addr & 0xffff)}`;
}

function addToArrayMap(map, key, value) {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

function addToSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function walkProv(prov, visit, seen = null) {
  if (!prov || typeof prov !== 'object') return;
  const localSeen = seen || new Set();
  const id = typeof prov.id === 'number' ? prov.id : null;
  const dedupeKey = id != null ? `p:${id}` : null;
  if (dedupeKey && localSeen.has(dedupeKey)) return;
  if (dedupeKey) localSeen.add(dedupeKey);
  visit(prov);
  switch (prov.kind) {
    case 'Add16':
      walkProv(prov.a, visit, localSeen);
      walkProv(prov.b, visit, localSeen);
      return;
    case 'Add8':
    case 'And8':
    case 'Or8':
    case 'Xor8':
    case 'Shl1':
    case 'Shr1':
      walkProv(prov.a, visit, localSeen);
      return;
    case 'ReadRom8':
      walkProv(prov.addrExpr, visit, localSeen);
      return;
    case 'ReadMem8':
      walkProv(prov.base, visit, localSeen);
      return;
    case 'Ptr16FromZp':
      walkProv(prov.loBase, visit, localSeen);
      walkProv(prov.hiBase, visit, localSeen);
      return;
    case 'Join':
      for (const option of prov.options || []) walkProv(option, visit, localSeen);
      return;
    case 'Filter':
      walkProv(prov.base, visit, localSeen);
      return;
    default:
      return;
  }
}


function normalizePhysicalRom(physicalRom) {
  if (!physicalRom || typeof physicalRom !== 'object') return { kind: 'unknown', romOffsets: [] };
  const vals = Array.isArray(physicalRom.romOffsets)
    ? Array.from(new Set(physicalRom.romOffsets
        .map((off) => (typeof off === 'number' ? off : Number(off)))
        .filter((off) => Number.isFinite(off) && off >= 0)
        .map((off) => off >>> 0))).sort((a, b) => a - b)
    : [];
  if (!vals.length) return { kind: 'unknown', romOffsets: [] };
  return { kind: vals.length === 1 ? 'exact' : (physicalRom.kind === 'set' ? 'set' : 'exact'), romOffsets: vals };
}
function shallowObsRef(obs) {
  const out = {
    id: String(obs.id),
    kind: obs.kind,
    atRomOff: typeof obs.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
    cpuAddr: typeof obs.cpuAddr === 'number' ? (obs.cpuAddr & 0xffff) : null,
    blockId: typeof obs.blockId === 'string' ? obs.blockId : null,
    entryFamilies: Array.isArray(obs.entryFamilies) ? [...obs.entryFamilies] : [],
    functionIds: Array.isArray(obs.functionIds) ? [...obs.functionIds] : []
  };
  if (obs.kind === 'store8') {
    out.srcReg = obs.srcReg || null;
    out.dst = obs.dst ? { space: obs.dst.space, addr: obs.dst.addr & 0xffff, name: (obs.dst.space === 'io') ? ioName(obs.dst.addr) : null } : null;
  }
  if (obs.kind === 'read8') {
    out.dstReg = obs.dstReg || null;
    out.src = obs.src ? { space: obs.src.space, addr: obs.src.addr & 0xffff, name: (obs.src.space === 'io') ? ioName(obs.src.addr) : null, romOff: typeof obs.src.romOff === 'number' ? (obs.src.romOff >>> 0) : null } : null;
    if (obs.src?.space === 'rom') {
      out.physicalRom = normalizePhysicalRom(obs.src.physicalRom || (typeof obs.src?.romOff === 'number' ? { kind: 'exact', romOffsets: [obs.src.romOff >>> 0] } : null));
    }
  }
  return out;
}

function observationNodeKind(obs) {
  if (obs.kind === 'read8') return 'readObservation';
  if (obs.kind === 'store8') return 'storeObservation';
  if (obs.kind === 'cmp8') return 'compareObservation';
  if (obs.kind === 'zpPtr16') return 'zeroPagePointerObservation';
  return 'observation';
}

function provenanceNodeKind(prov) {
  switch (prov.kind) {
    case 'ReadRom8': return 'romReadProvenance';
    case 'ReadMem8': return 'memoryReadProvenance';
    case 'Ptr16FromZp': return 'zeroPagePointerProvenance';
    case 'Const8': return 'const8Provenance';
    case 'Const16': return 'const16Provenance';
    case 'Add16': return 'add16Provenance';
    case 'Add8': return 'add8Provenance';
    case 'And8': return 'and8Provenance';
    case 'Or8': return 'or8Provenance';
    case 'Xor8': return 'xor8Provenance';
    case 'Shl1': return 'shiftLeftProvenance';
    case 'Shr1': return 'shiftRightProvenance';
    case 'Filter': return 'filterProvenance';
    case 'Join': return 'joinProvenance';
    case 'Unknown':
    default:
      return 'unknownProvenance';
  }
}

function provNodeLabel(prov) {
  switch (prov.kind) {
    case 'Const8': return `Const8 ${fmtHex(prov.v & 0xff, 2)}`;
    case 'Const16': return `Const16 ${fmtHex(prov.v & 0xffff, 4)}`;
    case 'ReadRom8': return 'ReadRom8';
    case 'ReadMem8': return `ReadMem8 ${prov.space}:${fmtHex(prov.addr & 0xffff, 4)}`;
    case 'Ptr16FromZp': return `Ptr16FromZp ${fmtHex(prov.zpAddr & 0xff, 2)}`;
    case 'Add16': return 'Add16';
    case 'Add8': return `Add8 ${prov.delta | 0}`;
    case 'And8': return `And8 ${fmtHex(prov.mask & 0xff, 2)}`;
    case 'Or8': return `Or8 ${fmtHex(prov.mask & 0xff, 2)}`;
    case 'Xor8': return `Xor8 ${fmtHex(prov.mask & 0xff, 2)}`;
    case 'Shl1': return 'Shl1';
    case 'Shr1': return 'Shr1';
    case 'Join': return 'Join';
    case 'Filter': return `Filter ${prov.pred?.op || ''}`.trim();
    case 'Unknown':
    default:
      return prov.kind || 'Unknown';
  }
}

function candidateDefsForRead(readObs, storeIdsByMemKey, observationsById, maxCandidateStoresPerRead) {
  const src = readObs?.src;
  if (!src) return [];
  if (!(src.space === 'zp' || src.space === 'ram' || src.space === 'prgram')) return [];
  const stores = storeIdsByMemKey.get(memKey(src.space, src.addr)) || [];
  if (!stores.length) return [];
  const atRomOff = typeof readObs.atRomOff === 'number' ? (readObs.atRomOff >>> 0) : null;
  const out = [];
  for (let i = stores.length - 1; i >= 0; i--) {
    const obsId = stores[i];
    const storeObs = observationsById.get(obsId);
    if (!storeObs) continue;
    if (atRomOff != null && typeof storeObs.atRomOff === 'number' && (storeObs.atRomOff >>> 0) > atRomOff) continue;
    out.push(obsId);
    if (out.length >= maxCandidateStoresPerRead) break;
  }
  return out;
}

function addGraphNode(nodes, nodeMap, node) {
  if (nodeMap.has(node.id)) return node.id;
  nodeMap.set(node.id, node);
  nodes.push(node);
  return node.id;
}

function addGraphEdge(edges, edgeSet, edge) {
  const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.meta ? JSON.stringify(edge.meta) : ''}`;
  if (edgeSet.has(key)) return;
  edgeSet.add(key);
  edges.push(edge);
}

function buildHardwareTrace({ rootObs, observationsById, readDefLinksByReadId, obsIdsByProvId, maxTraceDepth = 6 }) {
  const nodes = [];
  const edges = [];
  const nodeMap = new Map();
  const edgeSet = new Set();
  const expandedProvIds = new Set();
  const expandedObsIds = new Set();
  const summary = {
    romReadCount: 0,
    memReadCount: 0,
    zpPtrCount: 0,
    candidateDefCount: 0,
    unknownProvCount: 0,
    constLeafCount: 0
  };

  const rootNodeId = addGraphNode(nodes, nodeMap, {
    id: `root:${rootObs.id}`,
    kind: 'hardwareWriteRoot',
    observationId: String(rootObs.id),
    label: `Hardware write ${rootObs?.dst?.space === 'io' ? ioName(rootObs.dst.addr) : 'unknown'}`,
    target: rootObs?.dst ? { space: rootObs.dst.space, addr: rootObs.dst.addr & 0xffff } : null,
    atRomOff: typeof rootObs.atRomOff === 'number' ? (rootObs.atRomOff >>> 0) : null,
    cpuAddr: typeof rootObs.cpuAddr === 'number' ? (rootObs.cpuAddr & 0xffff) : null,
    blockId: rootObs.blockId || null,
    entryFamilies: Array.isArray(rootObs.entryFamilies) ? [...rootObs.entryFamilies] : [],
    functionIds: Array.isArray(rootObs.functionIds) ? [...rootObs.functionIds] : []
  });

  const rootObsNodeId = addObservationNode(rootObs);
  addGraphEdge(edges, edgeSet, { from: rootNodeId, to: rootObsNodeId, kind: 'traceRoot' });
  walkObservationValue(rootObs, rootObsNodeId, 0);

  return {
    id: `trace:${rootObs.id}`,
    rootObservationId: String(rootObs.id),
    target: {
      space: rootObs?.dst?.space || null,
      addr: typeof rootObs?.dst?.addr === 'number' ? (rootObs.dst.addr & 0xffff) : null,
      name: rootObs?.dst?.space === 'io' ? ioName(rootObs.dst.addr) : null
    },
    atRomOff: typeof rootObs.atRomOff === 'number' ? (rootObs.atRomOff >>> 0) : null,
    cpuAddr: typeof rootObs.cpuAddr === 'number' ? (rootObs.cpuAddr & 0xffff) : null,
    srcReg: rootObs.srcReg || null,
    graph: { rootNodeId, nodes, edges },
    summary
  };

  function addObservationNode(obs) {
    return addGraphNode(nodes, nodeMap, {
      id: `obs:${obs.id}`,
      kind: observationNodeKind(obs),
      observationId: String(obs.id),
      label: obs.kind === 'store8'
        ? `Store8 ${(obs.dst?.space === 'io') ? ioName(obs.dst.addr) : `${obs.dst?.space}:${fmtHex(obs.dst?.addr ?? 0, 4)}`}`
        : obs.kind === 'read8'
          ? `Read8 ${obs.src?.space}:${fmtHex(obs.src?.addr ?? 0, 4)}`
          : `${obs.label || obs.kind}`,
      atRomOff: typeof obs.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
      cpuAddr: typeof obs.cpuAddr === 'number' ? (obs.cpuAddr & 0xffff) : null,
      blockId: typeof obs.blockId === 'string' ? obs.blockId : null,
      entryFamilies: Array.isArray(obs.entryFamilies) ? [...obs.entryFamilies] : [],
      functionIds: Array.isArray(obs.functionIds) ? [...obs.functionIds] : [],
      srcReg: obs.srcReg || null,
      dstReg: obs.dstReg || null,
      dst: obs.dst ? { space: obs.dst.space, addr: obs.dst.addr & 0xffff } : null,
      src: obs.src ? { space: obs.src.space, addr: obs.src.addr & 0xffff } : null
    });
  }

  function addProvNode(prov) {
    const node = {
      id: `prov:${prov.id}`,
      kind: provenanceNodeKind(prov),
      provId: prov.id,
      provKind: prov.kind,
      label: provNodeLabel(prov)
    };
    if (prov.kind === 'ReadMem8') {
      node.space = prov.space;
      node.addr = prov.addr & 0xffff;
    }
    if (prov.kind === 'ReadRom8') node.indexSource = prov.indexSource || null;
    if (prov.kind === 'Ptr16FromZp') node.zpAddr = prov.zpAddr & 0xff;
    if (prov.kind === 'Const8' || prov.kind === 'Const16') node.value = prov.v;
    if (prov.kind === 'Filter') node.pred = prov.pred || null;
    return addGraphNode(nodes, nodeMap, node);
  }

  function walkObservationValue(obs, obsNodeId, depth) {
    if (!obs?.prov || typeof obs.prov.id !== 'number' || depth > maxTraceDepth) return;
    const provNodeId = walkProvNode(obs.prov, depth + 1);
    if (provNodeId) addGraphEdge(edges, edgeSet, { from: obsNodeId, to: provNodeId, kind: 'valueSource' });
  }

  function walkProvNode(prov, depth) {
    if (!prov || typeof prov !== 'object' || depth > maxTraceDepth) return null;
    const provNodeId = addProvNode(prov);
    const provId = typeof prov.id === 'number' ? prov.id : null;
    if (provId != null && expandedProvIds.has(provId)) return provNodeId;
    if (provId != null) expandedProvIds.add(provId);

    switch (prov.kind) {
      case 'Unknown':
        summary.unknownProvCount++;
        break;
      case 'Const8':
      case 'Const16':
        summary.constLeafCount++;
        break;
      case 'Add16':
        linkChild(provNodeId, prov.a, 'provenanceSource', depth);
        linkChild(provNodeId, prov.b, 'provenanceSource', depth);
        break;
      case 'Add8':
      case 'And8':
      case 'Or8':
      case 'Xor8':
      case 'Shl1':
      case 'Shr1':
      case 'Filter':
        linkChild(provNodeId, prov.a || prov.base, 'provenanceSource', depth);
        break;
      case 'Join':
        for (const option of prov.options || []) linkChild(provNodeId, option, 'provenanceSource', depth);
        break;
      case 'ReadRom8': {
        summary.romReadCount++;
        linkChild(provNodeId, prov.addrExpr, 'provenanceSource', depth);
        const linkedObsIds = obsIdsByProvId.get(prov.id) || [];
        const romOffsets = [];
        for (const obsId of linkedObsIds) {
          const obs = observationsById.get(obsId);
          if (!obs || obs.kind !== 'read8') continue;
          const phys = normalizePhysicalRom(obs.src?.physicalRom || (typeof obs.src?.romOff === 'number' ? { kind: 'exact', romOffsets: [obs.src.romOff >>> 0] } : null));
          for (const off of phys.romOffsets || []) romOffsets.push(off >>> 0);
          const obsNodeId = addObservationNode(obs);
          addGraphEdge(edges, edgeSet, { from: provNodeId, to: obsNodeId, kind: 'provenanceSource' });
        }
        const uniqueRomOffsets = Array.from(new Set(romOffsets)).sort((a, b) => a - b);
        if (uniqueRomOffsets.length === 1) {
          const off = uniqueRomOffsets[0] >>> 0;
          const provNode = nodeMap.get(provNodeId);
          provNode.space = 'rom';
          provNode.addr = off;
          provNode.physicalRom = { kind: 'exact', romOffsets: [off] };
        } else if (uniqueRomOffsets.length > 1) {
          const provNode = nodeMap.get(provNodeId);
          provNode.physicalRom = { kind: 'set', romOffsets: uniqueRomOffsets };
        }
        break;
      }
      case 'ReadMem8': {
        summary.memReadCount++;
        linkChild(provNodeId, prov.base, 'provenanceSource', depth);
        const linkedObsIds = obsIdsByProvId.get(prov.id) || [];
        for (const obsId of linkedObsIds) {
          const obs = observationsById.get(obsId);
          if (!obs || obs.kind !== 'read8') continue;
          const obsNodeId = addObservationNode(obs);
          addGraphEdge(edges, edgeSet, { from: provNodeId, to: obsNodeId, kind: 'provenanceSource' });
          const defLink = readDefLinksByReadId.get(String(obs.id));
          const candidateStoreIds = defLink?.candidateStoreIds || [];
          for (const storeObsId of candidateStoreIds) {
            summary.candidateDefCount++;
            const storeObs = observationsById.get(storeObsId);
            if (!storeObs) continue;
            const storeNodeId = addObservationNode(storeObs);
            addGraphEdge(edges, edgeSet, { from: obsNodeId, to: storeNodeId, kind: 'candidateDefinition' });
            if (!expandedObsIds.has(storeObsId) && depth < maxTraceDepth) {
              expandedObsIds.add(storeObsId);
              walkObservationValue(storeObs, storeNodeId, depth + 1);
            }
          }
        }
        break;
      }
      case 'Ptr16FromZp': {
        summary.zpPtrCount++;
        const linkedObsIds = obsIdsByProvId.get(prov.id) || [];
        for (const obsId of linkedObsIds) {
          const obs = observationsById.get(obsId);
          if (!obs || obs.kind !== 'zpPtr16') continue;
          const obsNodeId = addObservationNode(obs);
          addGraphEdge(edges, edgeSet, { from: provNodeId, to: obsNodeId, kind: 'provenanceSource' });
        }
        linkChild(provNodeId, prov.loBase, 'provenanceSource', depth);
        linkChild(provNodeId, prov.hiBase, 'provenanceSource', depth);
        break;
      }
      default:
        break;
    }

    return provNodeId;
  }

  function linkChild(parentNodeId, childProv, edgeKind, depth) {
    if (!childProv) return;
    const childNodeId = walkProvNode(childProv, depth + 1);
    if (!childNodeId) return;
    addGraphEdge(edges, edgeSet, { from: parentNodeId, to: childNodeId, kind: edgeKind });
  }
}

function buildAddressParticipation({ hardwareTraces }) {
  const byKey = new Map();

  function getEntry(addrInfo) {
    const key = memKey(addrInfo.space, addrInfo.addr);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        space: addrInfo.space,
        addr: addrInfo.space === 'rom' ? (addrInfo.addr >>> 0) : (addrInfo.addr & 0xffff),
        traceIds: new Set(),
        possibleTraceIds: new Set(),
        observationIds: new Set(),
        possibleObservationIds: new Set(),
        traceNodeIds: new Set(),
        possibleTraceNodeIds: new Set(),
        hardwareTargets: new Set(),
        possibleHardwareTargets: new Set(),
        blockIds: new Set(),
        possibleBlockIds: new Set(),
        functionIds: new Set(),
        possibleFunctionIds: new Set(),
        entryFamilies: new Set(),
        possibleEntryFamilies: new Set()
      };
      byKey.set(key, entry);
    }
    return entry;
  }

  function addParticipation(entry, node, traceId, hardwareTarget, possible = false) {
    const suffix = possible ? 'possible' : 'definite';
    (possible ? entry.possibleTraceIds : entry.traceIds).add(traceId);
    (possible ? entry.possibleTraceNodeIds : entry.traceNodeIds).add(node.id);
    if (typeof hardwareTarget === 'number') (possible ? entry.possibleHardwareTargets : entry.hardwareTargets).add(hardwareTarget & 0xffff);
    if (typeof node.observationId === 'string') (possible ? entry.possibleObservationIds : entry.observationIds).add(node.observationId);
    if (typeof node.blockId === 'string') (possible ? entry.possibleBlockIds : entry.blockIds).add(node.blockId);
    for (const functionId of node.functionIds || []) (possible ? entry.possibleFunctionIds : entry.functionIds).add(functionId);
    for (const family of node.entryFamilies || []) (possible ? entry.possibleEntryFamilies : entry.entryFamilies).add(family);
  }

  for (const trace of hardwareTraces || []) {
    const traceId = trace.id;
    const hardwareTarget = trace?.target?.addr;
    for (const node of trace?.graph?.nodes || []) {
      const addresses = [];
      if (node?.src?.space === 'rom') {
        const phys = normalizePhysicalRom(node.physicalRom);
        if (phys.kind === 'exact') {
          for (const romOff of phys.romOffsets) if (typeof romOff === 'number') addresses.push({ space: 'rom', addr: romOff >>> 0, possible: false });
        } else if (phys.kind === 'set') {
          for (const romOff of phys.romOffsets) if (typeof romOff === 'number') addresses.push({ space: 'rom', addr: romOff >>> 0, possible: true });
        }
      } else if (node?.src?.space && typeof node?.src?.addr === 'number') {
        addresses.push({ space: node.src.space, addr: node.src.addr & 0xffff, possible: false });
      }
      if (node?.dst?.space && typeof node?.dst?.addr === 'number') addresses.push({ space: node.dst.space, addr: node.dst.addr & 0xffff, possible: false });
      if ((node.kind === 'memoryReadProvenance' || node.kind === 'romReadProvenance') && typeof node.addr === 'number' && typeof node.space === 'string') {
        if (node.space === 'rom' && node?.physicalRom?.kind === 'set' && Array.isArray(node.physicalRom.romOffsets)) {
          for (const romOff of node.physicalRom.romOffsets) if (typeof romOff === 'number') addresses.push({ space: 'rom', addr: romOff >>> 0, possible: true });
        } else {
          addresses.push({ space: node.space, addr: node.addr & 0xfffffff, possible: false });
        }
      }
      if ((node.kind === 'zeroPagePointerObservation' || node.kind === 'zeroPagePointerProvenance') && typeof node.zpAddr === 'number') {
        addresses.push({ space: 'zp', addr: node.zpAddr & 0xff, possible: false });
        addresses.push({ space: 'zp', addr: (node.zpAddr + 1) & 0xff, possible: false });
      }

      for (const addrInfo of addresses) {
        const entry = getEntry(addrInfo);
        addParticipation(entry, node, traceId, hardwareTarget, !!addrInfo.possible);
      }
    }
  }

  const out = {};
  for (const [key, entry] of byKey.entries()) {
    out[key] = {
      key,
      space: entry.space,
      addr: entry.addr,
      traceIds: Array.from(entry.traceIds).sort(),
      possibleTraceIds: Array.from(entry.possibleTraceIds).sort(),
      observationIds: Array.from(entry.observationIds).sort(),
      possibleObservationIds: Array.from(entry.possibleObservationIds).sort(),
      traceNodeIds: Array.from(entry.traceNodeIds).sort(),
      possibleTraceNodeIds: Array.from(entry.possibleTraceNodeIds).sort(),
      hardwareTargets: Array.from(entry.hardwareTargets).sort((a, b) => a - b),
      possibleHardwareTargets: Array.from(entry.possibleHardwareTargets).sort((a, b) => a - b),
      blockIds: Array.from(entry.blockIds).sort(),
      possibleBlockIds: Array.from(entry.possibleBlockIds).sort(),
      functionIds: Array.from(entry.functionIds).sort(),
      possibleFunctionIds: Array.from(entry.possibleFunctionIds).sort(),
      entryFamilies: Array.from(entry.entryFamilies).sort(),
      possibleEntryFamilies: Array.from(entry.possibleEntryFamilies).sort()
    };
  }
  return out;
}

export function buildVsaDataflow({
  observationsResult,
  interestingIoAddrs = DEFAULT_TRACE_IO_ADDRS,
  maxCandidateStoresPerRead = 6,
  maxTraceDepth = 6
} = {}) {
  const observationsIn = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const observations = observationsIn.map((obs, index) => ({ ...obs, id: observationIdOf(obs, index) }));
  const observationsById = new Map(observations.map((obs) => [String(obs.id), obs]));
  const storeIdsByMemKey = new Map();
  const readDefLinks = [];
  const readDefLinksByReadId = new Map();
  const obsIdsByProvId = new Map();
  const ioWriteObservationIds = [];
  const interestingIoSet = new Set((interestingIoAddrs || []).map((x) => x & 0xffff));

  for (const obs of observations) {
    if (obs.kind === 'store8' && obs.dst?.space) {
      addToArrayMap(storeIdsByMemKey, memKey(obs.dst.space, obs.dst.addr), String(obs.id));
      if (obs.dst.space === 'io') ioWriteObservationIds.push(String(obs.id));
    }
    if (obs.prov) {
      walkProv(obs.prov, (prov) => {
        if (typeof prov.id !== 'number') return;
        addToArrayMap(obsIdsByProvId, prov.id, String(obs.id));
      });
    }
  }

  for (const obs of observations) {
    if (obs.kind !== 'read8' || !obs.src?.space) continue;
    const candidateStoreIds = candidateDefsForRead(obs, storeIdsByMemKey, observationsById, maxCandidateStoresPerRead);
    if (!candidateStoreIds.length) continue;
    const link = {
      readObservationId: String(obs.id),
      source: {
        space: obs.src.space,
        addr: obs.src.addr & 0xffff
      },
      candidateStoreIds
    };
    readDefLinks.push(link);
    readDefLinksByReadId.set(String(obs.id), link);
  }

  const interestingIoWriteObservationIds = ioWriteObservationIds.filter((obsId) => {
    const obs = observationsById.get(obsId);
    return obs?.dst?.space === 'io' && interestingIoSet.has(obs.dst.addr & 0xffff);
  });

  const hardwareTraces = interestingIoWriteObservationIds.map((obsId) => buildHardwareTrace({
    rootObs: observationsById.get(obsId),
    observationsById,
    readDefLinksByReadId,
    obsIdsByProvId,
    maxTraceDepth
  }));

  const ioWrites = ioWriteObservationIds.map((obsId) => {
    const obs = observationsById.get(obsId);
    return {
      observationId: obsId,
      atRomOff: typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
      cpuAddr: typeof obs?.cpuAddr === 'number' ? (obs.cpuAddr & 0xffff) : null,
      blockId: obs?.blockId || null,
      entryFamilies: Array.isArray(obs?.entryFamilies) ? [...obs.entryFamilies] : [],
      functionIds: Array.isArray(obs?.functionIds) ? [...obs.functionIds] : [],
      srcReg: obs?.srcReg || null,
      target: {
        addr: obs?.dst?.addr & 0xffff,
        name: ioName(obs?.dst?.addr ?? 0)
      }
    };
  });

  const addressParticipationByKey = buildAddressParticipation({ hardwareTraces });

  return {
    version: 2,
    interestingIoAddrs: Array.from(interestingIoSet).sort((a, b) => a - b),
    ioWrites,
    readDefLinks,
    hardwareTraces,
    addressParticipationByKey,
    stats: {
      observationCount: observations.length,
      ioWriteCount: ioWriteObservationIds.length,
      interestingIoWriteCount: interestingIoWriteObservationIds.length,
      readDefLinkCount: readDefLinks.length,
      hardwareTraceCount: hardwareTraces.length,
      addressParticipationCount: Object.keys(addressParticipationByKey).length
    }
  };
}
