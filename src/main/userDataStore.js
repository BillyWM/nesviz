import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeCpuAddr, normalizeRomOff } from '../shared/utils/addressNormalizeUtils.js';
import { normalizeWindowKey, normalizeWindowState } from './utils/windowStateNormalizeUtils.js';

const USER_DATA_VERSION = 3;
const USER_DATA_FILE = 'nesvizUserData.json';

let loaded = false;
let data = null;

function emptyData() {
  return { version: USER_DATA_VERSION, roms: {}, recentRoms: [], windows: {} };
}

function normalizeLabelText(label) {
  if (label == null) return '';
  const s = String(label).trim();
  if (!s) return '';
  return s.length > 80 ? s.slice(0, 80) : s;
}

function normalizeRomLabelEntry(key, value) {
  const romOff = normalizeRomOff(value?.romOff ?? key);
  const label = normalizeLabelText(value?.label ?? value);
  if (romOff === null || !label) return null;
  return { romOff, label };
}

function normalizeRomBookmark(bookmark) {
  const romOff = normalizeRomOff(bookmark?.romOff ?? bookmark);
  if (romOff === null) return null;
  return { romOff };
}

function keyForRomOff(romOff) {
  return String(romOff >>> 0);
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

    if (parsed.windows && typeof parsed.windows === 'object') {
      base.windows = parsed.windows;
    }

    return base;
  } catch {
    return emptyData();
  }
}

export async function getWindowState(key) {
  await ensureUserDataLoaded();
  const k = normalizeWindowKey(key);
  if (!k) return null;
  const raw = data.windows?.[k];
  return normalizeWindowState(raw);
}

export function getWindowStateSync(key) {
  if (!loaded || !data) return null;
  const k = normalizeWindowKey(key);
  if (!k) return null;
  const raw = data.windows?.[k];
  return normalizeWindowState(raw);
}

export async function setWindowState(key, state) {
  await ensureUserDataLoaded();
  const k = normalizeWindowKey(key);
  if (!k) return null;
  const s = normalizeWindowState(state);
  if (!s) return null;
  if (!data.windows || typeof data.windows !== 'object') data.windows = {};
  data.windows[k] = s;
  await saveToDisk();
  return s;
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

function entryHasLabels(entry) {
  return !!(entry?.labels && typeof entry.labels === 'object' && Object.keys(entry.labels).length > 0);
}

function entryHasAddrLabels(entry) {
  return !!(entry?.addrLabels && typeof entry.addrLabels === 'object' && Object.keys(entry.addrLabels).length > 0);
}

function entryHasBookmarks(entry) {
  return Array.isArray(entry?.bookmarks) && entry.bookmarks.length > 0;
}

function pruneOrStoreRomEntry(romHash, patch) {
  if (!data.roms) data.roms = {};
  const current = data.roms[romHash] || {};
  const merged = { ...current, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete merged[key];
  }
  if (!entryHasLabels(merged) && !entryHasAddrLabels(merged) && !entryHasBookmarks(merged)) {
    delete data.roms[romHash];
  } else {
    data.roms[romHash] = merged;
  }
}

export async function getBookmarksForRomHash(romHash) {
  await ensureUserDataLoaded();
  if (!romHash) return [];
  const entry = data.roms?.[romHash];
  const arr = Array.isArray(entry?.bookmarks) ? entry.bookmarks : [];
  const byKey = new Map();
  for (const bm of arr) {
    const n = normalizeRomBookmark(bm);
    if (!n) continue;
    byKey.set(keyForRomOff(n.romOff), n);
  }
  return Array.from(byKey.values()).sort((a, b) => a.romOff - b.romOff);
}

export async function setBookmarkForRomHash(romHash, romOff, set) {
  await ensureUserDataLoaded();
  if (!romHash) return [];

  const n = normalizeRomBookmark({ romOff });
  if (!n) return getBookmarksForRomHash(romHash);

  const prev = await getBookmarksForRomHash(romHash);
  const byKey = new Map(prev.map((bm) => [keyForRomOff(bm.romOff), bm]));
  const k = keyForRomOff(n.romOff);
  if (set) byKey.set(k, n);
  else byKey.delete(k);

  const next = Array.from(byKey.values()).sort((a, b) => a.romOff - b.romOff);
  pruneOrStoreRomEntry(romHash, { bookmarks: next.length ? next : null });

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
    if (addr === null || !text) continue;
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

  pruneOrStoreRomEntry(romHash, { addrLabels: Object.keys(next).length ? next : null });

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
    const item = normalizeRomLabelEntry(k, v);
    if (!item) continue;
    out[keyForRomOff(item.romOff)] = item;
  }
  return out;
}

export async function setLabelForRomHash(romHash, romOff, label) {
  await ensureUserDataLoaded();
  if (!romHash) return {};

  const off = normalizeRomOff(romOff);
  if (off === null) return getLabelsForRomHash(romHash);

  const text = normalizeLabelText(label);
  const prev = await getLabelsForRomHash(romHash);
  const next = { ...prev };
  const k = keyForRomOff(off);
  if (text) next[k] = { romOff: off, label: text };
  else delete next[k];

  pruneOrStoreRomEntry(romHash, { labels: Object.keys(next).length ? next : null });

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
  arr = arr.filter((p) => p !== fp);
  arr.unshift(fp);
  if (arr.length > maxItems) arr = arr.slice(0, maxItems);

  data.recentRoms = arr;
  await saveToDisk();
  return [...arr];
}
