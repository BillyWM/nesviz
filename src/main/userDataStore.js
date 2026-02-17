import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

// Single user-data JSON for per-ROM user annotations (bookmarks, etc).
// Note: we do NOT create ROM entries just because a ROM is opened.
// Entries are created only when data is actually stored (e.g. first bookmark).

const USER_DATA_VERSION = 1;
const USER_DATA_FILE = 'nesvizUserData.json';

let loaded = false;
let data = null;

function emptyData() {
  return { version: USER_DATA_VERSION, roms: {}, recentRoms: [] };
}

function normalizeRomOff(romOff) {
  const r = typeof romOff === 'number' ? romOff : Number(romOff);
  if (!Number.isFinite(r) || r < 0) return null;
  return r | 0;
}

function normalizeLabelText(label) {
  if (label == null) return '';
  const s = String(label).trim();
  // Blank label means "remove".
  if (!s) return '';
  // Keep labels reasonably short (no hard requirement, just sanity).
  return s.length > 80 ? s.slice(0, 80) : s;
}

function normalizeCpuAddr(addr) {
  const a = typeof addr === 'number' ? addr : Number(addr);
  if (!Number.isFinite(a) || a < 0) return null;
  return a & 0xffff;
}

function getFilePath() {
  const userDataDir = app.getPath('userData');
  return path.join(userDataDir, USER_DATA_FILE);
}

async function loadFromDisk() {
  try {
    const txt = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(txt);
    if (!parsed || parsed.version !== USER_DATA_VERSION) return emptyData();
    if (!parsed.roms || typeof parsed.roms !== 'object') return emptyData();

    const base = emptyData();
    base.roms = parsed.roms;

    if (Array.isArray(parsed.recentRoms)) {
      base.recentRoms = parsed.recentRoms.filter((p) => typeof p === 'string' && p.length > 0);
    }

    return base;
  } catch {
    return emptyData();
  }
}

async function saveToDisk() {
  if (!data) return;
  const fp = getFilePath();
  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(fp, payload, 'utf8');
}

export async function ensureUserDataLoaded() {
  if (loaded) return data;
  data = await loadFromDisk();
  loaded = true;
  return data;
}

function normalizeBookmark(bm) {
  if (!bm) return null;
  const romOff = typeof bm.romOff === 'number' ? bm.romOff : Number(bm.romOff);
  const cpuAddr = typeof bm.cpuAddr === 'number' ? bm.cpuAddr : Number(bm.cpuAddr);
  if (!Number.isFinite(romOff) || romOff < 0) return null;
  return {
    romOff: romOff | 0,
    cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null
  };
}

function keyForBookmark(bm) {
  // romOff is absolute in PRG space; treat it as the unique bookmark key.
  return String(bm.romOff | 0);
}

export async function getBookmarksForRomHash(romHash) {
  await ensureUserDataLoaded();
  if (!romHash) return [];
  const entry = data.roms?.[romHash];
  const arr = Array.isArray(entry?.bookmarks) ? entry.bookmarks : [];
  // Return normalized copies.
  return arr.map(normalizeBookmark).filter(Boolean);
}

export async function setBookmarkForRomHash(romHash, bm, set) {
  await ensureUserDataLoaded();
  if (!romHash) return [];

  const n = normalizeBookmark(bm);
  if (!n) return getBookmarksForRomHash(romHash);

  const entry = data.roms?.[romHash];
  const prev = Array.isArray(entry?.bookmarks) ? entry.bookmarks : [];
  const byKey = new Map();
  for (const p of prev) {
    const pn = normalizeBookmark(p);
    if (!pn) continue;
    byKey.set(keyForBookmark(pn), pn);
  }

  const k = keyForBookmark(n);
  if (set) byKey.set(k, n);
  else byKey.delete(k);

  const next = Array.from(byKey.values()).sort((a, b) => (a.romOff | 0) - (b.romOff | 0));

  if (next.length === 0) {
    // Remove the ROM entry entirely if empty.
    // Note: keep the entry if it still contains other data (e.g. labels).
    const entry = data.roms?.[romHash];
    const hasLabels = !!(entry?.labels && typeof entry.labels === 'object' && Object.keys(entry.labels).length > 0);
    const hasAddrLabels = !!(entry?.addrLabels && typeof entry.addrLabels === 'object' && Object.keys(entry.addrLabels).length > 0);
    if (!hasLabels && !hasAddrLabels) {
      if (data.roms && Object.prototype.hasOwnProperty.call(data.roms, romHash)) {
        delete data.roms[romHash];
      }
    } else {
      // Keep the entry but remove the bookmarks field.
      data.roms[romHash] = { ...(data.roms[romHash] || {}) };
      delete data.roms[romHash].bookmarks;
    }
  } else {
    if (!data.roms) data.roms = {};
    data.roms[romHash] = { ...(data.roms[romHash] || {}), bookmarks: next };
  }

  await saveToDisk();
  return next;
}

export async function getAddrLabelsForRomHash(romHash) {
  await ensureUserDataLoaded();
  if (!romHash) return {};
  const entry = data.roms?.[romHash];
  const labels = entry?.addrLabels;
  if (!labels || typeof labels !== 'object') return {};

  const out = {};
  for (const [k, v] of Object.entries(labels)) {
    const addr = normalizeCpuAddr(k);
    const text = normalizeLabelText(v);
    if (addr === null) continue;
    if (!text) continue;
    out[String(addr)] = text;
  }
  return out;
}

export async function setAddrLabelForRomHash(romHash, cpuAddr, label) {
  await ensureUserDataLoaded();
  if (!romHash) return {};

  const addr = normalizeCpuAddr(cpuAddr);
  if (addr === null) return getAddrLabelsForRomHash(romHash);

  const text = normalizeLabelText(label);

  const entry = data.roms?.[romHash];
  const prevRaw = (entry?.addrLabels && typeof entry.addrLabels === 'object') ? entry.addrLabels : {};

  const next = {};
  for (const [k, v] of Object.entries(prevRaw)) {
    const ka = normalizeCpuAddr(k);
    const vt = normalizeLabelText(v);
    if (ka === null || !vt) continue;
    next[String(ka)] = vt;
  }

  if (text) next[String(addr)] = text;
  else delete next[String(addr)];

  const hasAddrLabels = Object.keys(next).length > 0;
  const hasLabels = !!(entry?.labels && typeof entry.labels === 'object' && Object.keys(entry.labels).length > 0);
  const hasBookmarks = Array.isArray(entry?.bookmarks) && entry.bookmarks.length > 0;

  if (!hasAddrLabels && !hasLabels && !hasBookmarks) {
    if (data.roms && Object.prototype.hasOwnProperty.call(data.roms, romHash)) {
      delete data.roms[romHash];
    }
  } else {
    if (!data.roms) data.roms = {};
    const merged = { ...(data.roms[romHash] || {}) };
    if (hasAddrLabels) merged.addrLabels = next;
    else delete merged.addrLabels;
    data.roms[romHash] = merged;
  }

  await saveToDisk();
  return getAddrLabelsForRomHash(romHash);
}

export async function getLabelsForRomHash(romHash) {
  await ensureUserDataLoaded();
  if (!romHash) return {};
  const entry = data.roms?.[romHash];
  const labels = entry?.labels;
  if (!labels || typeof labels !== 'object') return {};

  const out = {};
  for (const [k, v] of Object.entries(labels)) {
    const romOff = normalizeRomOff(k);
    const text = normalizeLabelText(v);
    if (romOff === null) continue;
    if (!text) continue;
    out[String(romOff)] = text;
  }
  return out;
}

export async function setLabelForRomHash(romHash, romOff, label) {
  await ensureUserDataLoaded();
  if (!romHash) return {};

  const r = normalizeRomOff(romOff);
  if (r === null) return getLabelsForRomHash(romHash);

  const text = normalizeLabelText(label);

  const entry = data.roms?.[romHash];
  const prevRaw = (entry?.labels && typeof entry.labels === 'object') ? entry.labels : {};

  // Normalize + rebuild to avoid carrying junk keys.
  const next = {};
  for (const [k, v] of Object.entries(prevRaw)) {
    const ko = normalizeRomOff(k);
    const vt = normalizeLabelText(v);
    if (ko === null || !vt) continue;
    next[String(ko)] = vt;
  }

  if (text) next[String(r)] = text;
  else delete next[String(r)];

  const hasLabels = Object.keys(next).length > 0;
  const hasBookmarks = Array.isArray(entry?.bookmarks) && entry.bookmarks.length > 0;
  const hasAddrLabels = !!(entry?.addrLabels && typeof entry.addrLabels === 'object' && Object.keys(entry.addrLabels).length > 0);

  if (!hasLabels && !hasBookmarks && !hasAddrLabels) {
    if (data.roms && Object.prototype.hasOwnProperty.call(data.roms, romHash)) {
      delete data.roms[romHash];
    }
  } else {
    if (!data.roms) data.roms = {};
    const merged = { ...(data.roms[romHash] || {}) };
    if (hasLabels) merged.labels = next;
    else delete merged.labels;
    data.roms[romHash] = merged;
  }

  await saveToDisk();
  return getLabelsForRomHash(romHash);
}

export async function getRecentRomPaths() {
  await ensureUserDataLoaded();
  return Array.isArray(data.recentRoms) ? [...data.recentRoms] : [];
}

export async function recordRecentRomPath(filepath, maxItems = 10) {
  await ensureUserDataLoaded();
  if (!filepath) return getRecentRomPaths();

  const fp = String(filepath);
  let arr = Array.isArray(data.recentRoms) ? data.recentRoms.filter((p) => typeof p === 'string' && p.length > 0) : [];
  // Move existing to front.
  arr = arr.filter((p) => p !== fp);
  arr.unshift(fp);
  if (arr.length > maxItems) arr = arr.slice(0, maxItems);

  data.recentRoms = arr;
  await saveToDisk();
  return [...arr];
}
