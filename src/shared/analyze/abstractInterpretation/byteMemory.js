import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import {
  abstractByteFromSerializable,
  abstractByteToSerializable,
  byteEqual,
  isTopByte,
  joinByte,
  topByte,
  widenByte
} from './abstractByteDomain.js';

function canonicalByteRamAddr(cpuAddr) {
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  if (canonical.space === 'zp' || canonical.space === 'ram') return canonical.addr;
  return null;
}

function makeKey(canonicalRamAddr) {
  return canonicalRamAddr;
}

export function createByteMemory(entries = null) {
  return {
    entries: entries ? new Map(entries) : new Map()
  };
}

export function cloneByteMemory(memory) {
  return createByteMemory(memory.entries);
}

export function readByteAt(memory, cpuAddr) {
  const canonicalRamAddr = canonicalByteRamAddr(cpuAddr);
  if (canonicalRamAddr === null) return topByte();
  return memory.entries.get(makeKey(canonicalRamAddr)) || topByte();
}

export function writeByteAt(memory, cpuAddr, byte) {
  const canonicalRamAddr = canonicalByteRamAddr(cpuAddr);
  if (canonicalRamAddr === null) return memory;
  const key = makeKey(canonicalRamAddr);
  const normalized = abstractByteFromSerializable(byte);
  if (isTopByte(normalized)) memory.entries.delete(key);
  else memory.entries.set(key, normalized);
  return memory;
}

export function updateByteAt(memory, cpuAddr, updater) {
  const oldByte = readByteAt(memory, cpuAddr);
  return writeByteAt(memory, cpuAddr, updater(oldByte));
}

export function forgetByteAt(memory, cpuAddr) {
  return writeByteAt(memory, cpuAddr, topByte());
}

export function forgetAllBytes(memory) {
  memory.entries.clear();
  return memory;
}

export function joinByteMemory(a, b, options = {}) {
  const out = createByteMemory();
  for (const [key, leftByte] of a.entries.entries()) {
    if (!b.entries.has(key)) continue;
    const joined = joinByte(leftByte, b.entries.get(key), options);
    if (!isTopByte(joined)) out.entries.set(key, joined);
  }
  return out;
}

export function widenByteMemory(a, b, options = {}) {
  const out = createByteMemory();
  for (const [key, leftByte] of a.entries.entries()) {
    if (!b.entries.has(key)) continue;
    const widened = widenByte(leftByte, b.entries.get(key), options);
    if (!isTopByte(widened)) out.entries.set(key, widened);
  }
  return out;
}

export function byteMemoryEquals(a, b) {
  if (a.entries.size !== b.entries.size) return false;
  for (const [key, leftByte] of a.entries.entries()) {
    const rightByte = b.entries.get(key);
    if (!rightByte || !byteEqual(leftByte, rightByte)) return false;
  }
  return true;
}

export function byteMemoryToSerializable(memory) {
  return Array.from(memory.entries.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([addr, byte]) => ({
      addr,
      byte: abstractByteToSerializable(byte)
    }));
}

export function byteMemoryFromSerializable(entries) {
  const memory = createByteMemory();
  if (!Array.isArray(entries)) return memory;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const addr = Number(entry.addr);
    if (!Number.isInteger(addr)) continue;
    const byte = abstractByteFromSerializable(entry.byte || entry.bits);
    if (!isTopByte(byte)) memory.entries.set(addr & 0x07ff, byte);
  }
  return memory;
}
