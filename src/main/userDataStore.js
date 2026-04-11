import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UNKNOWN_FETCH_CTX_KEY, siteKeyFor } from '../shared/analyze/fetchContext.js';

const USER_DATA_VERSION = 2;
const USER_DATA_FILE = 'nesvizUserData.json';

let loaded = false;
let data = null;

function emptyData() {
  return { version: USER_DATA_VERSION, roms: {}, recentRoms: [], windows: {} };
}

function normalizeRomOff(romOff) {
  const r = typeof romOff === 'number' ? romOff : Number(romOff);
  if (!Number.isFinite(r) || r < 0) return null;
  return r | 0;
}

function normalizeLabelText(label) {
  if (label == null) return '';
  const s = String(label).trim();
  if (!s) return '';
  return s.length > 80 ? s.slice(0, 80) : s;
}

function normalizeCpuAddr(addr) {
  const a = typeof addr === 'number' ? addr : Number(addr);
  if (!Number.isFinite(a) || a < 0) return null;
  return a & 0xffff;
}

function normalizeCtxKey(ctxKey) {
  if (ctxKey == null) return UNKNOWN_FETCH_CTX_KEY;
  const s = String(ctxKey).trim();
  return s || UNKNOWN_FETCH_CTX_KEY;
}

function normalizeSiteRef(site) {
  if (!site || typeof site !== 'object') return null;
  const ctxKey = normalizeCtxKey(site.ctxKey);
  const cpuAddr = normalizeCpuAddr(site.cpuAddr);
  let siteKey = typeof site.siteKey === 'string' ? site.siteKey.trim() : '';
  if (!siteKey && cpuAddr !== null) siteKey = siteKeyFor(ctxKey, cpuAddr);
  if (!siteKey) return null;
  const romOff = normalizeRomOff(site.romOff);
  return {
    siteKey,
    ctxKey,
    cpuAddr,
    romOff
  };
}

function normalizeSiteLabelEntry(key, value) {
  const site = normalizeSiteRef({
    siteKey: key,
    ctxKey: value?.ctxKey,
    cpuAddr: value?.cpuAddr,
    romOff: value?.romOff
  });
  const label = normalizeLabelText(value?.label);
  if (!site || !label) return null;
  return { ...site, label };
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

function normalizeWindowKey(key) {
  if (!key) return null;
  const k = String(key).trim();
  if (!k) return null;
  return k.length > 80 ? k.slice(0, 80) : k;
}

function normalizeWindowState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  const maximized = !!raw.maximized;

  const out = { maximized };
  if (Number.isFinite(x)) out.x = x | 0;
  if (Number.isFinite(y)) out.y = y | 0;
  if (Number.isFinite(width) && width > 0) out.width = width | 0;
  if (Number.isFinite(height) && height > 0) out.height = height | 0;
  return out;
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

function normalizeBookmark(bm) {
  return normalizeSiteRef(bm);
}

function keyForBookmark(bm) {
  return bm.siteKey;
}

export async function getBookmarksForRomHash(romHash) {
  await ensureUserDataLoaded();
  if (!romHash) return [];
  const entry = data.roms?.[romHash];
  const arr = Array.isArray(entry?.bookmarks) ? entry.bookmarks : [];
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

  const next = Array.from(byKey.values()).sort((a, b) => {
    const ar = (a.romOff ?? Number.MAX_SAFE_INTEGER);
    const br = (b.romOff ?? Number.MAX_SAFE_INTEGER);
    if (ar !== br) return ar - br;
    const ac = a.cpuAddr ?? 0;
    const bc = b.cpuAddr ?? 0;
    return ac - bc;
  });

  if (next.length === 0) {
    const hasLabels = !!(entry?.labels && typeof entry.labels === 'object' && Object.keys(entry.labels).length > 0);
    const hasAddrLabels = !!(entry?.addrLabels && typeof entry.addrLabels === 'object' && Object.keys(entry.addrLabels).length > 0);
    if (!hasLabels && !hasAddrLabels) {
      if (data.roms && Object.prototype.hasOwnProperty.call(data.roms, romHash)) delete data.roms[romHash];
    } else {
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

  const hasAddrLabels = Object.keys(next).length > 0;
  const hasLabels = !!(entry?.labels && typeof entry.labels === 'object' && Object.keys(entry.labels).length > 0);
  const hasBookmarks = Array.isArray(entry?.bookmarks) && entry.bookmarks.length > 0;

  if (!hasAddrLabels && !hasLabels && !hasBookmarks) {
    if (data.roms && Object.prototype.hasOwnProperty.call(data.roms, romHash)) delete data.roms[romHash];
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
    const item = normalizeSiteLabelEntry(k, v);
    if (!item) continue;
    out[item.siteKey] = item;
  }
  return out;
}

export async function setLabelForRomHash(romHash, site, label) {
  await ensureUserDataLoaded();
  if (!romHash) return {};

  const n = normalizeSiteRef(site);
  if (!n) return getLabelsForRomHash(romHash);

  const text = normalizeLabelText(label);
  const entry = data.roms?.[romHash];
  const prevRaw = (entry?.labels && typeof entry.labels === 'object') ? entry.labels : {};

  const next = {};
  for (const [k, v] of Object.entries(prevRaw)) {
    const item = normalizeSiteLabelEntry(k, v);
    if (!item) continue;
    next[item.siteKey] = item;
  }

  if (text) next[n.siteKey] = { ...n, label: text };
  else delete next[n.siteKey];

  const hasLabels = Object.keys(next).length > 0;
  const hasBookmarks = Array.isArray(entry?.bookmarks) && entry.bookmarks.length > 0;
  const hasAddrLabels = !!(entry?.addrLabels && typeof entry.addrLabels === 'object' && Object.keys(entry.addrLabels).length > 0);

  if (!hasLabels && !hasBookmarks && !hasAddrLabels) {
    if (data.roms && Object.prototype.hasOwnProperty.call(data.roms, romHash)) delete data.roms[romHash];
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
  arr = arr.filter((p) => p !== fp);
  arr.unshift(fp);
  if (arr.length > maxItems) arr = arr.slice(0, maxItems);

  data.recentRoms = arr;
  await saveToDisk();
  return [...arr];
}
