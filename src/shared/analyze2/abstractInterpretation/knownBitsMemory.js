import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import {
  isTopKnownBits,
  joinKnownBits,
  knownBitsEqual,
  knownBitsFromSerializable,
  knownBitsToSerializable,
  topKnownBits
} from './knownBitsDomain.js';

function canonicalKnownBitsRamAddr(cpuAddr) {
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  if (canonical.space === 'zp' || canonical.space === 'ram') return canonical.addr;
  return null;
}

function makeKey(canonicalRamAddr) {
  return canonicalRamAddr;
}

export function createKnownBitsMemory(entries = null) {
  return {
    entries: entries ? new Map(entries) : new Map()
  };
}

export function cloneKnownBitsMemory(memory) {
  return createKnownBitsMemory(memory.entries);
}

export function readKnownBitsAt(memory, cpuAddr) {
  const canonicalRamAddr = canonicalKnownBitsRamAddr(cpuAddr);
  if (canonicalRamAddr === null) return topKnownBits();
  return memory.entries.get(makeKey(canonicalRamAddr)) || topKnownBits();
}

export function writeKnownBitsAt(memory, cpuAddr, bits) {
  const canonicalRamAddr = canonicalKnownBitsRamAddr(cpuAddr);
  if (canonicalRamAddr === null) return memory;
  const key = makeKey(canonicalRamAddr);
  if (isTopKnownBits(bits)) memory.entries.delete(key);
  else memory.entries.set(key, bits);
  return memory;
}

export function updateKnownBitsAt(memory, cpuAddr, updater) {
  const oldBits = readKnownBitsAt(memory, cpuAddr);
  return writeKnownBitsAt(memory, cpuAddr, updater(oldBits));
}

export function forgetKnownBitsAt(memory, cpuAddr) {
  return writeKnownBitsAt(memory, cpuAddr, topKnownBits());
}

export function forgetAllKnownBits(memory) {
  memory.entries.clear();
  return memory;
}

export function joinKnownBitsMemory(a, b) {
  const out = createKnownBitsMemory();
  for (const [key, leftBits] of a.entries.entries()) {
    if (!b.entries.has(key)) continue;
    const joined = joinKnownBits(leftBits, b.entries.get(key));
    if (!isTopKnownBits(joined)) out.entries.set(key, joined);
  }
  return out;
}

export function knownBitsMemoryEquals(a, b) {
  if (a.entries.size !== b.entries.size) return false;
  for (const [key, leftBits] of a.entries.entries()) {
    const rightBits = b.entries.get(key);
    if (!rightBits || !knownBitsEqual(leftBits, rightBits)) return false;
  }
  return true;
}

export function knownBitsMemoryToSerializable(memory) {
  return Array.from(memory.entries.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([addr, bits]) => ({
      addr,
      bits: knownBitsToSerializable(bits)
    }));
}


export function knownBitsMemoryFromSerializable(entries) {
  const memory = createKnownBitsMemory();
  if (!Array.isArray(entries)) return memory;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const addr = Number(entry.addr);
    if (!Number.isInteger(addr)) continue;
    const bits = knownBitsFromSerializable(entry.bits);
    if (!isTopKnownBits(bits)) memory.entries.set(addr & 0x07ff, bits);
  }
  return memory;
}
