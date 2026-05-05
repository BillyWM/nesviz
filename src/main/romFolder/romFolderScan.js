import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseInesHeader } from '../../shared/rom/ines.js';
import { getStaticAnalysisSupportInfo } from '../../shared/rom/mapperInfo.js';
import { getFolderSelectionKey, normalizeFolderPaths } from '../utils/folderPathUtils.js';

const ROM_FOLDER_CACHE_VERSION = 6;
const ROM_FOLDER_CACHE_FILE = 'romFolderCache.json';
const CACHE_BATCH_SIZE = 50;
const SCAN_BATCH_SIZE = 25;
const SCAN_PROGRESS_INTERVAL = 50;

let romFolderCache = null;
let romFolderCacheLoadPromise = null;

function getStaticAnalysisInfoForHeader(header) {
  return getStaticAnalysisSupportInfo(header?.analysisMapper || null);
}

export function decorateRomFolderItem(item) {
  const base = item && typeof item === 'object' ? item : {};
  const info = getStaticAnalysisSupportInfo(base.analysisMapper || null);
  return {
    ...base,
    isAnalyzable: !!info.isAnalyzable,
    analysisKind: info.analysisKind || null
  };
}

function toCachedRomFolderItem({ fullPath, filename, header, nromKind }) {
  return {
    filePath: fullPath,
    filename,
    prgBytes: header.prgBytes,
    chrBytes: header.chrBytes,
    mapperNumber: header.mapperNumber,
    mapperName: header.mapperName,
    nromKind,
    hasTrainer: header.hasTrainer,
    isInes2: header.isInes2,
    analysisMapper: header.analysisMapper || null
  };
}

async function readInesHeaderOnly(filepath) {
  const fh = await fs.open(filepath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    if (bytesRead < 16) return null;

    let header;
    try {
      header = parseInesHeader(buf);
    } catch {
      return null;
    }

    const isNrom = header.mapperNumber === 0;
    const nromKind = isNrom
      ? (header.prgSize <= 16384 ? 'NROM-128' : 'NROM-256')
      : null;

    const analysisInfo = getStaticAnalysisInfoForHeader(header);

    return {
      mapperNumber: header.mapperNumber,
      submapperNumber: header.submapperNumber,
      mapperName: header.mapperName,
      prgBytes: header.prgSize,
      chrBytes: header.chrSize,
      hasTrainer: header.hasTrainer,
      isInes2: header.isNes2,
      isTargetMapper: header.isTargetMapper,
      isAnalyzable: !!analysisInfo.isAnalyzable,
      analysisKind: analysisInfo.analysisKind || null,
      nromKind,
      analysisMapper: header.analysisMapper
    };
  } finally {
    await fh.close();
  }
}

async function loadRomFolderCache() {
  try {
    const userDataDir = app.getPath('userData');
    const filePath = path.join(userDataDir, ROM_FOLDER_CACHE_FILE);
    const txt = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(txt);
    if (!data || !Array.isArray(data.items)) return null;

    let folderPaths = [];
    if (data.version === ROM_FOLDER_CACHE_VERSION) {
      folderPaths = normalizeFolderPaths(data.folderPaths);
    } else if (data.version === 5 && typeof data.folderPath === 'string') {
      folderPaths = normalizeFolderPaths([data.folderPath]);
    } else {
      return null;
    }

    if (!folderPaths.length) return null;

    return {
      version: ROM_FOLDER_CACHE_VERSION,
      folderPaths,
      selectionKey: getFolderSelectionKey(folderPaths),
      items: data.items,
      meta: data.meta && typeof data.meta === 'object' ? data.meta : null,
      savedAtMs: typeof data.savedAtMs === 'number' ? data.savedAtMs : null
    };
  } catch {
    return null;
  }
}

async function saveRomFolderCache(cache) {
  if (!cache) return;
  const folderPaths = normalizeFolderPaths(cache.folderPaths);
  if (!folderPaths.length) return;
  const userDataDir = app.getPath('userData');
  const filePath = path.join(userDataDir, ROM_FOLDER_CACHE_FILE);
  const payload = {
    version: ROM_FOLDER_CACHE_VERSION,
    folderPaths,
    items: cache.items || [],
    meta: cache.meta || null,
    savedAtMs: cache.savedAtMs || Date.now()
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function ensureRomFolderCacheLoaded() {
  if (!romFolderCacheLoadPromise) {
    romFolderCacheLoadPromise = (async () => {
      romFolderCache = await loadRomFolderCache();
      return romFolderCache;
    })();
  }
  return romFolderCacheLoadPromise;
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('ROM folder scan canceled');
  err.name = 'AbortError';
  throw err;
}

function getCachedScanCounts(items, meta) {
  const totalCount = Number.isFinite(meta?.totalCount) ? meta.totalCount : items.length;
  const scannedCount = Number.isFinite(meta?.scannedCount) ? meta.scannedCount : totalCount;
  const foundCount = Number.isFinite(meta?.foundCount) ? meta.foundCount : items.length;
  const errorCount = Number.isFinite(meta?.errorCount) ? meta.errorCount : 0;
  return { totalCount, scannedCount, foundCount, errorCount };
}

export async function getRomFolderCacheForRenderer() {
  await ensureRomFolderCacheLoaded();
  if (!romFolderCache || !Array.isArray(romFolderCache.folderPaths) || !romFolderCache.folderPaths.length) {
    return { ok: true, hasCache: false };
  }
  return {
    ok: true,
    hasCache: true,
    folderPaths: romFolderCache.folderPaths.slice(),
    items: Array.isArray(romFolderCache.items)
      ? romFolderCache.items.map((item) => decorateRomFolderItem(item))
      : [],
    meta: romFolderCache.meta || null,
    savedAtMs: romFolderCache.savedAtMs || null
  };
}

export async function* scanRomFolders({ folderPaths, force = false, signal } = {}) {
  const normalizedFolderPaths = normalizeFolderPaths(folderPaths);
  if (!normalizedFolderPaths.length) throw new Error('No folderPaths provided');

  await ensureRomFolderCacheLoaded();
  throwIfAborted(signal);

  const selectionKey = getFolderSelectionKey(normalizedFolderPaths);
  const canUseCache = !force
    && romFolderCache
    && romFolderCache.selectionKey === selectionKey
    && Array.isArray(romFolderCache.items);

  if (canUseCache) {
    const items = romFolderCache.items.map((item) => decorateRomFolderItem(item));
    const counts = getCachedScanCounts(items, romFolderCache.meta || {});
    yield {
      type: 'start',
      folderPaths: romFolderCache.folderPaths.slice(),
      totalCount: counts.totalCount
    };

    for (let i = 0; i < items.length; i += CACHE_BATCH_SIZE) {
      throwIfAborted(signal);
      yield {
        type: 'batch',
        items: items.slice(i, i + CACHE_BATCH_SIZE),
        scannedCount: counts.scannedCount,
        totalCount: counts.totalCount,
        foundCount: counts.foundCount,
        errorCount: counts.errorCount
      };
    }

    yield {
      type: 'done',
      scannedCount: counts.scannedCount,
      totalCount: counts.totalCount,
      foundCount: counts.foundCount,
      errorCount: counts.errorCount,
      cached: true
    };
    return;
  }

  let scanned = 0;
  let found = 0;
  let errors = 0;
  const batch = [];
  const allFound = [];

  yield {
    type: 'start',
    folderPaths: normalizedFolderPaths.slice(),
    totalCount: null
  };

  for (const folderPath of normalizedFolderPaths) {
    throwIfAborted(signal);

    let dir;
    try {
      dir = await fs.opendir(folderPath);
    } catch {
      errors++;
      yield {
        type: 'batch',
        items: [],
        scannedCount: scanned,
        totalCount: null,
        foundCount: found,
        errorCount: errors
      };
      continue;
    }

    let names = [];
    try {
      for await (const dirent of dir) {
        throwIfAborted(signal);
        if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.nes')) continue;
        names.push(dirent.name);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      errors++;
      yield {
        type: 'batch',
        items: batch.splice(0, batch.length),
        scannedCount: scanned,
        totalCount: null,
        foundCount: found,
        errorCount: errors
      };
      continue;
    }

    names = names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      throwIfAborted(signal);

      const fullPath = path.join(folderPath, name);
      scanned++;
      try {
        const header = await readInesHeaderOnly(fullPath);
        if (header && header.isTargetMapper) {
          found++;
          const item = toCachedRomFolderItem({
            fullPath,
            filename: name,
            header,
            nromKind: header.nromKind
          });
          allFound.push(item);
          batch.push(decorateRomFolderItem(item));
        }
      } catch {
        errors++;
      }

      if (batch.length >= SCAN_BATCH_SIZE || scanned % SCAN_PROGRESS_INTERVAL === 0) {
        yield {
          type: 'batch',
          items: batch.splice(0, batch.length),
          scannedCount: scanned,
          totalCount: null,
          foundCount: found,
          errorCount: errors
        };
      }
    }
  }

  if (batch.length) {
    yield {
      type: 'batch',
      items: batch.splice(0, batch.length),
      scannedCount: scanned,
      totalCount: null,
      foundCount: found,
      errorCount: errors
    };
  }

  const meta = {
    scannedCount: scanned,
    totalCount: scanned,
    foundCount: found,
    errorCount: errors
  };

  yield {
    type: 'done',
    ...meta
  };

  romFolderCache = {
    version: ROM_FOLDER_CACHE_VERSION,
    folderPaths: normalizedFolderPaths,
    selectionKey,
    items: allFound,
    meta,
    savedAtMs: Date.now()
  };
  try {
    await saveRomFolderCache(romFolderCache);
  } catch {
    // Ignore persistence errors.
  }
}
