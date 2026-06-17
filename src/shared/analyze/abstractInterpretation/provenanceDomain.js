export const PROVENANCE_KIND = Object.freeze({
  UNKNOWN: 'unknown',
  NODE: 'node',
  SET: 'set'
});

const DEFAULT_ALTERNATIVE_CAP = 8;
const DEFAULT_DEPTH_CAP = 6;

function altCap(options = {}) {
  return Number.isFinite(options.maxProvenanceAlternatives)
    ? Math.max(1, options.maxProvenanceAlternatives | 0)
    : DEFAULT_ALTERNATIVE_CAP;
}

function depthCap(options = {}) {
  return Number.isFinite(options.maxProvenanceDepth)
    ? Math.max(1, options.maxProvenanceDepth | 0)
    : DEFAULT_DEPTH_CAP;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function stableKey(value) {
  return JSON.stringify(canonicalize(value));
}

function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function normalizedNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.kind !== 'string') return null;
  return cloneJson(node);
}

function nodeDepth(node) {
  if (!node || typeof node !== 'object') return 0;
  if (node.kind === 'op') {
    const args = Array.isArray(node.args) ? node.args : [];
    return 1 + Math.max(0, ...args.map((arg) => nodeDepth(arg)));
  }
  return 1;
}

function sortNodes(nodes) {
  return nodes.slice().sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
}

function uniqueNodes(nodes) {
  const out = [];
  const seen = new Set();
  for (const raw of nodes || []) {
    const node = normalizedNode(raw);
    if (!node) continue;
    const key = stableKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return sortNodes(out);
}

function nodeSetFromProvenance(provenance) {
  const normalized = provenanceFromSerializable(provenance);
  if (normalized.kind === PROVENANCE_KIND.UNKNOWN) return null;
  if (normalized.kind === PROVENANCE_KIND.NODE) return [normalized.node];
  return normalized.items;
}

export function unknownProvenance() {
  return { kind: PROVENANCE_KIND.UNKNOWN };
}

export function nodeProvenance(node, options = {}) {
  const normalized = normalizedNode(node);
  if (!normalized) return unknownProvenance();
  if (nodeDepth(normalized) > depthCap(options)) return unknownProvenance();
  return { kind: PROVENANCE_KIND.NODE, node: normalized };
}

export function setProvenance(nodes, options = {}) {
  const items = uniqueNodes(nodes);
  if (items.length === 0) return unknownProvenance();
  if (items.length > altCap(options)) return unknownProvenance();
  if (items.some((node) => nodeDepth(node) > depthCap(options))) return unknownProvenance();
  if (items.length === 1) return nodeProvenance(items[0], options);
  return { kind: PROVENANCE_KIND.SET, items };
}

export function provenanceFromSerializable(value) {
  if (!value || typeof value !== 'object') return unknownProvenance();
  if (value.kind === PROVENANCE_KIND.UNKNOWN) return unknownProvenance();
  if (value.kind === PROVENANCE_KIND.NODE) return nodeProvenance(value.node || null);
  if (value.kind === PROVENANCE_KIND.SET) return setProvenance(value.items || []);
  return unknownProvenance();
}

export function provenanceToSerializable(value) {
  return cloneProvenance(value);
}

export function cloneProvenance(value) {
  return provenanceFromSerializable(cloneJson(value));
}

export function isUnknownProvenance(value) {
  return provenanceFromSerializable(value).kind === PROVENANCE_KIND.UNKNOWN;
}

export function provenanceEqual(a, b) {
  return stableKey(provenanceFromSerializable(a)) === stableKey(provenanceFromSerializable(b));
}

export function provenanceKey(value) {
  const normalized = provenanceFromSerializable(value);
  if (normalized.kind === PROVENANCE_KIND.UNKNOWN) return null;
  return stableKey(normalized);
}

export function joinProvenance(a, b, options = {}) {
  const left = provenanceFromSerializable(a);
  const right = provenanceFromSerializable(b);
  if (left.kind === PROVENANCE_KIND.UNKNOWN || right.kind === PROVENANCE_KIND.UNKNOWN) return unknownProvenance();
  return setProvenance([
    ...(nodeSetFromProvenance(left) || []),
    ...(nodeSetFromProvenance(right) || [])
  ], options);
}

export function widenProvenance(a, b, options = {}) {
  return joinProvenance(a, b, options);
}

export function immediateProvenance(value) {
  return nodeProvenance({ kind: 'immediate', value: Number(value) & 0xff });
}

export function entryRegisterProvenance(registerName) {
  return nodeProvenance({ kind: 'entryRegister', registerName: String(registerName || '') });
}

export function ramReadProvenance(cpuAddr) {
  return nodeProvenance({ kind: 'ramRead', cpuAddr: Number(cpuAddr) & 0xffff });
}

export function romReadProvenance({ cpuAddr, romOff, byte }) {
  const node = {
    kind: 'romRead',
    cpuAddr: Number(cpuAddr) & 0xffff,
    romOff: Number(romOff) >>> 0
  };
  if (Number.isFinite(byte)) node.byte = Number(byte) & 0xff;
  return nodeProvenance(node);
}

export function indexedRomReadProvenance({ cpuBase, indexRegister, indexProvenance, indexValues, candidates }, options = {}) {
  const indexProvKey = provenanceKey(indexProvenance);
  if (!indexProvKey) return unknownProvenance();
  const values = Array.isArray(indexValues)
    ? Array.from(new Set(indexValues.map((value) => Number(value) & 0xff))).sort((a, b) => a - b)
    : [];
  const normalizedCandidates = Array.isArray(candidates)
    ? candidates.map((candidate) => ({
      index: Number(candidate.index) & 0xff,
      cpuAddr: Number(candidate.cpuAddr) & 0xffff,
      romOff: Number(candidate.romOff) >>> 0,
      byte: Number(candidate.byte) & 0xff
    })).sort((a, b) => a.index - b.index || a.cpuAddr - b.cpuAddr || a.romOff - b.romOff)
    : [];
  if (!values.length || normalizedCandidates.length !== values.length) return unknownProvenance();
  return nodeProvenance({
    kind: 'indexedRomRead',
    cpuBase: Number(cpuBase) & 0xffff,
    indexRegister: String(indexRegister || ''),
    indexProvKey,
    indexValues: values,
    candidates: normalizedCandidates
  }, options);
}

export function jsrReturnProvenance({ role, sourceInstructionId, callSiteRomOff, encodedReturnAddr } = {}, options = {}) {
  const node = {
    kind: 'jsrReturn',
    role: role === 'high' ? 'high' : 'low',
    sourceInstructionId: Number(sourceInstructionId) >>> 0,
    callSiteRomOff: Number(callSiteRomOff) >>> 0
  };
  if (Number.isFinite(encodedReturnAddr)) node.encodedReturnAddr = Number(encodedReturnAddr) & 0xffff;
  return nodeProvenance(node, options);
}

export function opProvenance(opKind, args, options = {}) {
  const choices = [];
  for (const arg of args || []) {
    const normalized = provenanceFromSerializable(arg);
    if (normalized.kind === PROVENANCE_KIND.UNKNOWN) return unknownProvenance();
    choices.push(normalized.kind === PROVENANCE_KIND.SET ? normalized.items : [normalized.node]);
  }

  let combinations = [[]];
  for (const alternatives of choices) {
    const next = [];
    for (const combination of combinations) {
      for (const alternative of alternatives) {
        next.push([...combination, alternative]);
        if (next.length > altCap(options)) return unknownProvenance();
      }
    }
    combinations = next;
  }

  return setProvenance(combinations.map((argNodes) => ({
    kind: 'op',
    op: String(opKind || ''),
    args: argNodes
  })), options);
}

export function nodesForProvenance(value) {
  const nodes = nodeSetFromProvenance(value);
  return nodes ? nodes.map((node) => cloneJson(node)) : null;
}
