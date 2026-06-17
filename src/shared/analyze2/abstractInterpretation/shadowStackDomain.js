import {
  abstractByteFromSerializable,
  abstractByteToSerializable,
  byteEqual,
  joinByte,
  topByte,
  widenByte
} from './abstractByteDomain.js';
import {
  cloneProvenance,
  joinProvenance,
  provenanceEqual,
  provenanceFromSerializable,
  provenanceToSerializable,
  unknownProvenance,
  widenProvenance
} from './provenanceDomain.js';

const DEFAULT_DEPTH = 8;
const DEFAULT_RETURN_SITE_SET_CAP = 8;

function stackDepth(options = {}) {
  return Number.isFinite(options.shadowStackDepth)
    ? Math.max(1, options.shadowStackDepth | 0)
    : DEFAULT_DEPTH;
}

function returnSiteSetCap(options = {}) {
  return Number.isFinite(options.returnSiteSetCap)
    ? Math.max(1, options.returnSiteSetCap | 0)
    : DEFAULT_RETURN_SITE_SET_CAP;
}

function normalizeReturnSite(returnSite) {
  if (!returnSite || typeof returnSite !== 'object') return null;
  if (typeof returnSite.blockInstanceId !== 'string') return null;
  return {
    blockInstanceId: returnSite.blockInstanceId,
    siteKey: typeof returnSite.siteKey === 'string' ? returnSite.siteKey : null,
    contextKey: typeof returnSite.contextKey === 'string' ? returnSite.contextKey : null,
    cpuAddr: Number.isFinite(returnSite.cpuAddr) ? (returnSite.cpuAddr & 0xffff) : null,
    romOff: Number.isFinite(returnSite.romOff) ? (returnSite.romOff >>> 0) : null
  };
}

function returnSiteKey(returnSite) {
  const normalized = normalizeReturnSite(returnSite);
  return normalized ? `${normalized.blockInstanceId}|${normalized.siteKey || ''}|${normalized.contextKey || ''}|${normalized.cpuAddr ?? ''}|${normalized.romOff ?? ''}` : '';
}

function normalizeReturnSites(slot) {
  const raw = Array.isArray(slot?.returnSites)
    ? slot.returnSites
    : (slot?.returnSite ? [slot.returnSite] : []);
  const byKey = new Map();
  for (const item of raw) {
    const normalized = normalizeReturnSite(item);
    if (!normalized) continue;
    byKey.set(returnSiteKey(normalized), normalized);
  }
  return Array.from(byKey.values()).sort((a, b) => returnSiteKey(a).localeCompare(returnSiteKey(b)));
}

function cloneReturnSites(slot) {
  return normalizeReturnSites(slot).map((site) => ({ ...site }));
}

function returnSiteSetsEqual(a, b) {
  const left = normalizeReturnSites({ returnSites: a });
  const right = normalizeReturnSites({ returnSites: b });
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (returnSiteKey(left[index]) !== returnSiteKey(right[index])) return false;
  }
  return true;
}

function joinReturnSites(a, b, options = {}) {
  const left = normalizeReturnSites({ returnSites: a });
  const right = normalizeReturnSites({ returnSites: b });
  if (left.length === 0 && right.length === 0) return [];
  if (left.length === 0 || right.length === 0) return [];

  const byKey = new Map();
  for (const site of [...left, ...right]) byKey.set(returnSiteKey(site), site);
  if (byKey.size > returnSiteSetCap(options)) return [];
  return Array.from(byKey.values()).sort((siteA, siteB) => returnSiteKey(siteA).localeCompare(returnSiteKey(siteB)));
}

function normalizeSlot(slot) {
  return {
    byte: abstractByteFromSerializable(slot?.byte),
    provenance: provenanceFromSerializable(slot?.provenance),
    returnSites: cloneReturnSites(slot)
  };
}

function cloneSlot(slot) {
  const normalized = normalizeSlot(slot);
  return {
    byte: abstractByteFromSerializable(normalized.byte),
    provenance: cloneProvenance(normalized.provenance),
    returnSites: normalized.returnSites.map((site) => ({ ...site }))
  };
}

export function createShadowStack(slots = []) {
  return {
    slots: Array.isArray(slots) ? slots.map((slot) => cloneSlot(slot)).slice(0, DEFAULT_DEPTH) : []
  };
}

export function cloneShadowStack(stack) {
  return createShadowStack(stack?.slots || []);
}

export function shadowStackPush(stack, slot, options = {}) {
  const out = cloneShadowStack(stack);
  out.slots.unshift(cloneSlot(slot));
  out.slots = out.slots.slice(0, stackDepth(options));
  return out;
}

export function shadowStackPop(stack) {
  const out = cloneShadowStack(stack);
  if (!out.slots.length) {
    return {
      stack: out,
      slot: { byte: topByte(), provenance: unknownProvenance(), returnSites: [] }
    };
  }
  const slot = out.slots.shift();
  return { stack: out, slot };
}

export function invalidateShadowStack() {
  return createShadowStack();
}

function combineStacks(a, b, combiner, options = {}) {
  const left = a?.slots || [];
  const right = b?.slots || [];
  if (left.length !== right.length) return invalidateShadowStack();
  return createShadowStack(left.map((leftSlot, index) => combiner(leftSlot, right[index], options)));
}

export function joinShadowStack(a, b, options = {}) {
  return combineStacks(a, b, (leftSlot, rightSlot) => ({
    byte: joinByte(leftSlot.byte, rightSlot.byte, options),
    provenance: joinProvenance(leftSlot.provenance, rightSlot.provenance, options),
    returnSites: joinReturnSites(leftSlot.returnSites, rightSlot.returnSites, options)
  }), options);
}

export function widenShadowStack(a, b, options = {}) {
  return combineStacks(a, b, (leftSlot, rightSlot) => ({
    byte: widenByte(leftSlot.byte, rightSlot.byte, options),
    provenance: widenProvenance(leftSlot.provenance, rightSlot.provenance, options),
    returnSites: joinReturnSites(leftSlot.returnSites, rightSlot.returnSites, options)
  }), options);
}

export function shadowStackEquals(a, b) {
  const left = a?.slots || [];
  const right = b?.slots || [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!byteEqual(left[index].byte, right[index].byte)) return false;
    if (!provenanceEqual(left[index].provenance, right[index].provenance)) return false;
    if (!returnSiteSetsEqual(left[index].returnSites, right[index].returnSites)) return false;
  }
  return true;
}

export function shadowStackToSerializable(stack) {
  return {
    slots: (stack?.slots || []).map((slot) => ({
      byte: abstractByteToSerializable(slot.byte),
      provenance: provenanceToSerializable(slot.provenance),
      returnSites: cloneReturnSites(slot)
    }))
  };
}

export function shadowStackFromSerializable(value) {
  return createShadowStack(Array.isArray(value?.slots) ? value.slots : []);
}

export function shadowStackPeek(stack, index) {
  const slot = (stack?.slots || [])[index];
  return slot ? cloneSlot(slot) : null;
}

export function shadowStackSlotHasReturnSite(slot, blockInstanceId) {
  if (typeof blockInstanceId !== 'string') return false;
  return normalizeReturnSites(slot).some((site) => site.blockInstanceId === blockInstanceId);
}
