import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import {
  cloneProvenance,
  isUnknownProvenance,
  joinProvenance,
  provenanceEqual,
  provenanceFromSerializable,
  provenanceToSerializable,
  unknownProvenance,
  widenProvenance
} from './provenanceDomain.js';

function canonicalRamAddr(cpuAddr) {
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  if (canonical.space === 'zp' || canonical.space === 'ram') return canonical.addr & 0x07ff;
  return null;
}

export function createProvenanceMemory(entries = null) {
  return {
    entries: entries ? new Map(entries) : new Map()
  };
}

export function cloneProvenanceMemory(memory) {
  const out = createProvenanceMemory();
  for (const [key, provenance] of (memory?.entries || new Map()).entries()) {
    out.entries.set(key, cloneProvenance(provenance));
  }
  return out;
}

export function readProvenanceAt(memory, cpuAddr) {
  const addr = canonicalRamAddr(cpuAddr);
  if (addr === null) return unknownProvenance();
  return cloneProvenance(memory.entries.get(addr) || unknownProvenance());
}

export function writeProvenanceAt(memory, cpuAddr, provenance) {
  const addr = canonicalRamAddr(cpuAddr);
  if (addr === null) return memory;
  const normalized = provenanceFromSerializable(provenance);
  if (isUnknownProvenance(normalized)) memory.entries.delete(addr);
  else memory.entries.set(addr, normalized);
  return memory;
}

export function forgetProvenanceAt(memory, cpuAddr) {
  return writeProvenanceAt(memory, cpuAddr, unknownProvenance());
}

export function forgetAllProvenance(memory) {
  memory.entries.clear();
  return memory;
}

export function joinProvenanceMemory(a, b, options = {}) {
  const out = createProvenanceMemory();
  for (const [key, left] of (a?.entries || new Map()).entries()) {
    if (!b?.entries?.has(key)) continue;
    const joined = joinProvenance(left, b.entries.get(key), options);
    if (!isUnknownProvenance(joined)) out.entries.set(key, joined);
  }
  return out;
}

export function widenProvenanceMemory(a, b, options = {}) {
  const out = createProvenanceMemory();
  for (const [key, left] of (a?.entries || new Map()).entries()) {
    if (!b?.entries?.has(key)) continue;
    const widened = widenProvenance(left, b.entries.get(key), options);
    if (!isUnknownProvenance(widened)) out.entries.set(key, widened);
  }
  return out;
}

export function provenanceMemoryEquals(a, b) {
  if ((a?.entries?.size || 0) !== (b?.entries?.size || 0)) return false;
  for (const [key, left] of (a?.entries || new Map()).entries()) {
    if (!b.entries.has(key)) return false;
    if (!provenanceEqual(left, b.entries.get(key))) return false;
  }
  return true;
}

export function provenanceMemoryToSerializable(memory) {
  return Array.from((memory?.entries || new Map()).entries())
    .sort((a, b) => a[0] - b[0])
    .map(([addr, provenance]) => ({
      addr,
      provenance: provenanceToSerializable(provenance)
    }));
}

export function provenanceMemoryFromSerializable(entries) {
  const memory = createProvenanceMemory();
  if (!Array.isArray(entries)) return memory;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const addr = Number(entry.addr);
    if (!Number.isInteger(addr)) continue;
    const provenance = provenanceFromSerializable(entry.provenance);
    if (!isUnknownProvenance(provenance)) memory.entries.set(addr & 0x07ff, provenance);
  }
  return memory;
}
