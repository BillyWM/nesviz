import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { parseInes, parseInesHeader, readVectorsFromLastPrgBank } from '../shared/rom/ines.js';
import { sliceCdlForRom } from '../shared/analyze/cdl/nesCdl.js';
import { updateRecentRoms } from './menu.js';
import { appendAnalysisLogLines } from './analysisLogWindow.js';
import { getTuningState } from './tuningState.js';
import { buildGraphData } from '../shared/analyze/visual/buildGraphData.js';
import { notifyMemoryMapDataChanged } from './memoryMapWindow.js';
import { notifyGraphDataChanged } from './graphWindow.js';
import { loadAnalysisCache, saveAnalysisCache } from './analysisCache.js';
import {
  getBookmarksForRomHash,
  setBookmarkForRomHash,
  getLabelsForRomHash,
  setLabelForRomHash,
  getAddrLabelsForRomHash,
  setAddrLabelForRomHash,
  recordRecentRomPath,
  getRecentRomPaths
} from './userDataStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let nextFolderScanId = 1;

// Single-ROM app: the currently loaded ROM and its analysis state.
let active = null;

// If static analysis is running, this holds the active worker so we can terminate it when switching ROMs.
let activeWorker = null;

function formatAnalysisLogLines({ filename, mapperKind, analysis }) {
  const ts = new Date().toLocaleTimeString();
  const probable = analysis?.probable || {};
  const stats = analysis?.stats || {};
  const coverage = typeof stats.coveragePct === 'number' ? `${stats.coveragePct.toFixed(2)}%` : 'n/a';
  const capHit = probable.globalCapHit ? 'yes' : 'no';
  const cap = Number.isFinite(probable.maxPromotedChunks) ? probable.maxPromotedChunks : 'n/a';
  const lines = [
    `[${ts}] Static analysis complete for ${filename || '(unknown ROM)'} (${mapperKind || 'NROM'}).`,
    `Blocks: ${stats.blockCount ?? 'n/a'} · Coverage: ${coverage}.`,
    `Probable chunks: kept ${probable.keptChunkCount ?? 0}, promoted ${probable.promotedChunkCount ?? 0}, seeds ${probable.promotedSeedCount ?? 0}. Global cap hit: ${capHit} (cap ${cap}).`
  ];
  if (Number.isFinite(analysis?.debug?.vectorSeedCount)) {
    lines.push(`Vector/context seed sites: ${analysis.debug.vectorSeedCount}.`);
  }
  const regionSummaries = Array.isArray(probable.regionSummaries) ? probable.regionSummaries : [];
  for (const region of regionSummaries) {
    const label = Number.isFinite(region.bankIndex)
      ? `PRG bank ${region.bankIndex}`
      : `Range ${fmtHexRange(region.rangeStart, region.rangeEnd)}`;
    const best = Number.isFinite(region.bestScore) ? region.bestScore.toFixed(2) : 'n/a';
    lines.push(`  ${label} [${fmtHexRange(region.rangeStart, region.rangeEnd)}]: probe starts ${region.probeStartCount ?? 0}, passing ${region.passingCandidateCount ?? 0}, kept ${region.keptCandidateCount ?? 0}, best score ${best}.`);
  }
  return lines;
}

function fmtHexRange(start, end) {
  return `${fmtHex(start, 6)}-${fmtHex((end | 0) - 1, 6)}`;
}

function fmtHex(value, width) {
  const n = Math.max(0, value | 0);
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function getStaticAnalysisMapperKind(header) {
  const m = header?.mapperNumber | 0;
  const family = header?.analysisMapper?.mapperFamily || null;
  if (m === 3 || m === 185) return 'CNROM';
  if (m === 13) return 'CPROM';
  if (m === 2) return 'UxROM';
  if (m === 94) return 'UN1ROM';
  if (m === 7) return 'AxROM';
  if (m === 66) return 'GxROM';
  if (m === 1) return 'MMC1';
  if (m === 34 && family === 'BNROM') return 'BNROM';
  return 'NROM';
}

function clearActiveAnalysisState(s) {
  if (!s) return;
  s.analysisRaw = null;
  s.analysis = null;
  s.blockAliases = null;
  s.blockById = null;
}

function applyAnalysisResultToActiveState(s, result) {
  if (!s) throw new Error('No active ROM');
  const raw = result?.raw ?? null;
  const analysis = result?.analysis ?? null;
  const blockAliases = result?.blockAliases ?? null;
  if (!analysis || !Array.isArray(analysis.blocks)) {
    throw new Error('Invalid analysis payload');
  }
  s.analysisRaw = raw;
  s.analysis = analysis;
  s.blockAliases = blockAliases;
  s.blockById = new Map(analysis.blocks.map((b) => [b.id, b]));
}


function parseAddressKey(key) {
  const [space, addrText] = String(key || '').split(':');
  const addr = Number.parseInt(addrText, 10);
  if (!space || !Number.isFinite(addr)) return null;
  return { space, addr: space === 'rom' ? (addr >>> 0) : (addr & 0xffff) };
}

function coalesceOccupiedRanges(bits, start = 0, end = bits?.length || 0) {
  const ranges = [];
  let idx = Math.max(0, start | 0);
  const limit = Math.max(idx, Math.min(bits?.length || 0, end | 0));
  while (idx < limit) {
    while (idx < limit && !bits[idx]) idx++;
    if (idx >= limit) break;
    const rangeStart = idx;
    idx++;
    while (idx < limit && bits[idx]) idx++;
    ranges.push({ start: rangeStart - start, end: idx - start, type: 'group' });
  }
  return ranges;
}

function getBlockConfidenceById(blocks) {
  const map = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id || '');
    if (!id) continue;
    const confidence = block?.confidence === 'probable' ? 'probable' : 'certain';
    const prev = map.get(id);
    if (prev === 'certain') continue;
    map.set(id, confidence);
  }
  return map;
}

function classifyGroupType(group, blockConfidenceById) {
  const baseType = group?.space === 'rom' ? 'romData' : 'group';
  const touching = Array.isArray(group?.touchingBlockIds) ? group.touchingBlockIds : [];
  if (!touching.length) return baseType;
  let sawProbable = false;
  for (const blockId of touching) {
    const conf = blockConfidenceById.get(String(blockId));
    if (conf === 'certain') return baseType;
    if (conf === 'probable') sawProbable = true;
  }
  return sawProbable ? `${baseType}Light` : baseType;
}

function applyTypedRange(types, start, end, type) {
  const limit = Math.min(types.length, end | 0);
  for (let i = Math.max(0, start | 0); i < limit; i++) {
    const prev = types[i] || 'empty';
    if (prev === 'code') continue;
    if (type === 'code') {
      types[i] = 'code';
      continue;
    }
    if (type === 'codeLight') {
      types[i] = prev === 'empty' ? 'codeLight' : prev;
      continue;
    }
    if (prev === 'codeLight') continue;
    if (type === 'romData' || type === 'group') {
      types[i] = type;
      continue;
    }
    if (type === 'romDataLight') {
      if (prev === 'empty' || prev === 'groupLight') types[i] = 'romDataLight';
      continue;
    }
    if (type === 'groupLight') {
      if (prev === 'empty') types[i] = 'groupLight';
    }
  }
}

function coalesceTypedRanges(types, start = 0, end = types?.length || 0) {
  const ranges = [];
  let idx = Math.max(0, start | 0);
  const limit = Math.max(idx, Math.min(types?.length || 0, end | 0));
  while (idx < limit) {
    const type = types[idx] || 'empty';
    const rangeStart = idx;
    idx++;
    while (idx < limit && (types[idx] || 'empty') === type) idx++;
    ranges.push({ start: rangeStart - start, end: idx - start, type });
  }
  return ranges;
}

function getPrgRegionSizeBytes(analysisMapper, prgSize) {
  const meta = analysisMapper || null;
  if (meta?.prgWindowModel === 'mmc1-variable') return 16 * 1024;
  const swap = Number(meta?.prgSwapUnitBytes);
  if (Number.isFinite(swap) && swap > 0) return swap | 0;
  const slots = Array.isArray(meta?.prgFetchLayout?.slots) ? meta.prgFetchLayout.slots : [];
  const slotSizes = slots
    .map((slot) => Number(slot?.sizeBytes))
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => a - b);
  if (slotSizes.length) return slotSizes[0] | 0;
  return Math.max(1, prgSize | 0);
}

function buildMemoryMapDataForActive() {
  const s = active;
  if (!s?.ines) {
    return {
      ok: true,
      hasRom: false,
      hasAnalysis: false,
      rowWidthBytes: 64,
      cellSizePx: 16,
      ram: null,
      prg: null,
      rom: null,
      mapper: null
    };
  }

  const rowWidthBytes = 64;
  const cellSizePx = 16;
  const prgBytes = s.ines.prg;
  const prgSize = prgBytes?.length | 0;
  const analysis = s.analysis || null;
  const groups = Array.isArray(analysis?.memoryDiscoveries?.groups) ? analysis.memoryDiscoveries.groups : [];
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const blockConfidenceById = getBlockConfidenceById(blocks);

  const ramTypes = new Array(0x800).fill('empty');
  for (const group of groups) {
    if (group?.space === 'rom') continue;
    const groupType = classifyGroupType(group, blockConfidenceById);
    for (const key of group?.memberAddressKeys || []) {
      const parsed = parseAddressKey(key);
      if (!parsed) continue;
      if (parsed.space === 'zp') {
        if (parsed.addr >= 0 && parsed.addr < 0x100) applyTypedRange(ramTypes, parsed.addr, parsed.addr + 1, groupType);
      } else if (parsed.space === 'ram') {
        if (parsed.addr >= 0 && parsed.addr < 0x800) applyTypedRange(ramTypes, parsed.addr, parsed.addr + 1, groupType);
      }
    }
  }

  const ramOccupiedRanges = coalesceTypedRanges(ramTypes, 0, ramTypes.length);

  const prgTypes = new Array(Math.max(0, prgSize)).fill('empty');
  for (const group of groups) {
    if (group?.space !== 'rom') continue;
    const groupType = classifyGroupType(group, blockConfidenceById);
    for (const span of group?.spans || []) {
      const start = Math.max(0, Math.min(prgTypes.length, Number(span?.start) | 0));
      const end = Math.max(start, Math.min(prgTypes.length, (Number(span?.end) | 0) + 1));
      applyTypedRange(prgTypes, start, end, groupType);
    }
  }

  for (const block of blocks) {
    const romStart = Number(block?.romStart);
    const romEnd = Number(block?.romEnd);
    if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
    const start = Math.max(0, Math.min(prgTypes.length, romStart | 0));
    const end = Math.max(start, Math.min(prgTypes.length, romEnd | 0));
    const blockType = 'code';
    applyTypedRange(prgTypes, start, end, blockType);
  }

  const analysisMapper = s.ines.analysisMapper || analysis?.mapper?.meta || null;
  const regionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const regions = [];
  for (let start = 0, index = 0; start < prgSize; start += regionSizeBytes, index++) {
    const end = Math.min(prgSize, start + regionSizeBytes);
    regions.push({
      index,
      start,
      end,
      occupiedRanges: coalesceTypedRanges(prgTypes, start, end)
    });
  }

  return {
    ok: true,
    hasRom: true,
    hasAnalysis: !!analysis,
    rowWidthBytes,
    cellSizePx,
    rom: {
      filename: s.filename,
      mapperNumber: s.ines.mapperNumber,
      prgSize
    },
    mapper: analysis?.mapper || { kind: null, meta: analysisMapper },
    ram: {
      sizeBytes: 0x800,
      occupiedRanges: ramOccupiedRanges
    },
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes,
      regions
    }
  };
}

function runStaticAnalysisInWorker(payload, opts = null) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const onWorker = typeof opts?.onWorker === 'function' ? opts.onWorker : null;
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'analysisWorker.js');

    // In preview/production builds the worker is emitted as a separate main entry. If it's missing,
    // the user likely needs to rebuild.
    fs.access(workerPath).then(() => {
      const worker = new Worker(workerPath, { workerData: payload });
      if (onWorker) {
        try { onWorker(worker); } catch {}
      }

      let done = false;
      function finishOk(msg) {
        if (done) return;
        done = true;
        worker.removeAllListeners();
        resolve(msg);
      }
      function finishErr(err) {
        if (done) return;
        done = true;
        worker.removeAllListeners();
        reject(err);
      }

      worker.on('message', (msg) => {
        // Progress messages stream while the worker runs.
        if (msg && msg.kind === 'vsaProgress') {
          if (onProgress) {
            try { onProgress(msg); } catch {}
          }
          return;
        }

        // First non-progress message is treated as the final result.
        finishOk(msg);
      });
      worker.once('error', finishErr);
      worker.once('exit', (code) => {
        if (done) return;
        if (code === 0) finishErr(new Error('Analysis worker exited without sending a result'));
        else finishErr(new Error(`Analysis worker exited with code ${code}`));
      });
    }).catch(() => {
      reject(new Error(`Analysis worker not found: ${workerPath}. Run: npm run build`));
    });
  });
}

// Persisted ROM folder scan cache.
const ROM_FOLDER_CACHE_VERSION = 2;
const ROM_FOLDER_CACHE_FILE = 'romFolderCache.json';
let romFolderCache = null;
let romFolderCacheLoadPromise = null;

function normFolderPath(p) {
  if (!p) return '';
  const resolved = path.resolve(p);
  // On Windows, treat paths case-insensitively.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function loadRomFolderCache() {
  try {
    const userDataDir = app.getPath('userData');
    const filePath = path.join(userDataDir, ROM_FOLDER_CACHE_FILE);
    const txt = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(txt);
    if (!data || data.version !== ROM_FOLDER_CACHE_VERSION) return null;
    if (typeof data.folderPath !== 'string') return null;
    if (!Array.isArray(data.items)) return null;
    return {
      version: ROM_FOLDER_CACHE_VERSION,
      folderPath: data.folderPath,
      folderKey: normFolderPath(data.folderPath),
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
  const userDataDir = app.getPath('userData');
  const filePath = path.join(userDataDir, ROM_FOLDER_CACHE_FILE);
  const payload = {
    version: ROM_FOLDER_CACHE_VERSION,
    folderPath: cache.folderPath,
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

async function terminateActiveWorker() {
  const w = activeWorker;
  if (!w) return;
  activeWorker = null;
  try {
    // terminate() returns a Promise in modern Node, but older versions may return void.
    const r = w.terminate();
    if (r && typeof r.then === 'function') await r;
  } catch {
    // Ignore termination failures.
  }
}

async function resolveStartupRomPath() {
  const recent = await getRecentRomPaths();
  for (const filepath of recent) {
    if (!filepath || typeof filepath !== 'string') continue;
    try {
      await fs.access(filepath);
      return filepath;
    } catch {
      // Ignore stale paths in the recent list.
    }
  }
  return null;
}

export function registerAnalysisIpc() {
  async function openRomFromPath(filepath) {
    const buf = await fs.readFile(filepath);
    const ines = parseInes(buf);
    const vectors = readVectorsFromLastPrgBank(ines);

    // Whole-file hash for per-ROM user annotations (bookmarks, etc).
    const romHash = crypto.createHash('sha1').update(buf).digest('hex');
    const bookmarks = await getBookmarksForRomHash(romHash);
    const labels = await getLabelsForRomHash(romHash);
    const addrLabels = await getAddrLabelsForRomHash(romHash);

    // NesViz supports only one active ROM/analysis at a time.
    // When opening a new ROM, terminate any running analysis and discard prior state.
    await terminateActiveWorker();

    active = {
      filepath,
      filename: path.basename(filepath),
      romHash,
      ines,
      vectors,
      cdl: null,
      analysisRaw: null,
      analysis: null,
      blockAliases: null,
      blockById: null
    };

    let cachedAnalysisLoaded = false;
    try {
      const cachedResult = await loadAnalysisCache(romHash);
      applyAnalysisResultToActiveState(active, cachedResult);
      cachedAnalysisLoaded = true;
    } catch (err) {
      clearActiveAnalysisState(active);
      if (err?.code !== 'ENOENT') {
        console.warn('Analysis cache load failed while opening ROM; ignoring cached analysis:', err);
      }
    }

    // Update recent ROMs (persisted in userData). This also refreshes the app menu.
    try {
      const recentRoms = await recordRecentRomPath(filepath, 10);
      updateRecentRoms(recentRoms);
    } catch {
      // Ignore recent list failures.
    }
    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    return {
      ok: true,
      romHash,
      bookmarks,
      labels,
      addrLabels,
      rom: {
        filename: path.basename(filepath),
        mapperNumber: ines.mapperNumber,
        prgSize: ines.prg.length,
        chrSize: ines.chr.length
      },
      vectors,
      hasCachedAnalysis: cachedAnalysisLoaded
    };
  }

  function isStaticAnalysisSupportedHeader(header) {
    if (!header) return false;
    const kind = getStaticAnalysisMapperKind(header);
    return kind === 'NROM' ? ((header.mapperNumber | 0) === 0) : !!kind;
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

      return {
        mapperNumber: header.mapperNumber,
        submapperNumber: header.submapperNumber,
        mapperName: header.mapperName,
        prgBytes: header.prgSize,
        chrBytes: header.chrSize,
        hasTrainer: header.hasTrainer,
        isInes2: header.isNes2,
        isTargetMapper: header.isTargetMapper,
        isAnalysisSupported: isStaticAnalysisSupportedHeader(header),
        nromKind,
        analysisMapper: header.analysisMapper
      };
    } finally {
      await fh.close();
    }
  }

  ipcMain.handle('nesviz:openRom', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open NES ROM',
      properties: ['openFile'],
      filters: [
        { name: 'NES ROM', extensions: ['nes'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const filepath = result.filePaths[0];
    return openRomFromPath(filepath);
  });

  ipcMain.handle('nesviz:openRomPath', async (_evt, { filepath }) => {
    if (!filepath) return { ok: false, error: 'No filepath provided' };
    return openRomFromPath(filepath);
  });

  ipcMain.handle('nesviz:getStartupRomPath', async () => {
    const filepath = await resolveStartupRomPath();
    return { ok: true, filepath };
  });

  ipcMain.handle('nesviz:getActiveLabels', async () => {
    const s = active;

    if (!s?.romHash) {
      return { ok: true, hasRom: false, labels: {}, addrLabels: {} };
    }

    const labels = await getLabelsForRomHash(s.romHash);
    const addrLabels = await getAddrLabelsForRomHash(s.romHash);
    return { ok: true, hasRom: true, romHash: s.romHash, labels, addrLabels };
  });

  ipcMain.handle('nesviz:setBookmark', async (_evt, { site, set }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };
    if (!site || typeof site !== 'object') return { ok: false, error: 'Invalid site' };

    const next = await setBookmarkForRomHash(s.romHash, site, !!set);
    return { ok: true, bookmarks: next };
  });

  ipcMain.handle('nesviz:setLabel', async (_evt, { site, label }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };
    if (!site || typeof site !== 'object') return { ok: false, error: 'Invalid site' };

    const next = await setLabelForRomHash(s.romHash, site, label);
    return { ok: true, labels: next };
  });

  ipcMain.handle('nesviz:setAddrLabel', async (_evt, { cpuAddr, label }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    const a = typeof cpuAddr === 'number' ? cpuAddr : Number(cpuAddr);
    if (!Number.isFinite(a) || a < 0) return { ok: false, error: 'Invalid cpuAddr' };

    const next = await setAddrLabelForRomHash(s.romHash, a, label);
    return { ok: true, addrLabels: next };
  });

  ipcMain.handle('nesviz:selectRomFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select ROM Folder',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }
    return { ok: true, folderPath: result.filePaths[0] };
  });

  ipcMain.handle('nesviz:getRomFolderCache', async () => {
    await ensureRomFolderCacheLoaded();
    if (!romFolderCache || !romFolderCache.folderPath) {
      return { ok: true, hasCache: false };
    }
    return {
      ok: true,
      hasCache: true,
      folderPath: romFolderCache.folderPath,
      items: Array.isArray(romFolderCache.items) ? romFolderCache.items : [],
      meta: romFolderCache.meta || null,
      savedAtMs: romFolderCache.savedAtMs || null
    };
  });

  ipcMain.handle('nesviz:startRomFolderScan', async (evt, { folderPath, force }) => {
    if (!folderPath) return { ok: false, error: 'No folderPath provided' };
    await ensureRomFolderCacheLoaded();

    const scanId = `fs${nextFolderScanId++}`;
    const wc = evt.sender;

    const folderKey = normFolderPath(folderPath);
    const canUseCache = !force && romFolderCache && romFolderCache.folderKey === folderKey && Array.isArray(romFolderCache.items);

    function send(payload) {
      try {
        if (!wc || wc.isDestroyed()) return;
        wc.send('nesviz:romFolderScan', payload);
      } catch {
        // Ignore send failures.
      }
    }

    // Stream results in small batches to avoid huge single payloads.
    // Start on the next tick so the renderer can receive the scanId first.
    setTimeout(() => void (async () => {
      try {
        if (canUseCache) {
          const items = romFolderCache.items || [];
          const meta = romFolderCache.meta || {};
          const totalCount = Number.isFinite(meta.totalCount) ? meta.totalCount : items.length;
          const scannedCount = Number.isFinite(meta.scannedCount) ? meta.scannedCount : totalCount;
          const foundCount = Number.isFinite(meta.foundCount) ? meta.foundCount : items.length;
          const errorCount = Number.isFinite(meta.errorCount) ? meta.errorCount : 0;

          send({ scanId, type: 'start', folderPath: romFolderCache.folderPath, totalCount });

          const batchSize = 50;
          for (let i = 0; i < items.length; i += batchSize) {
            const chunk = items.slice(i, i + batchSize);
            send({
              scanId,
              type: 'batch',
              items: chunk,
              scannedCount,
              totalCount,
              foundCount,
              errorCount
            });
          }

          send({ scanId, type: 'done', scannedCount, totalCount, foundCount, errorCount, cached: true });
          return;
        }

        let total = 0;
        let scanned = 0;
        let found = 0;
        let errors = 0;
        const batch = [];
        const allFound = [];

        const entries = await fs.readdir(folderPath, { withFileTypes: true });
        const files = entries
          .filter((d) => d.isFile())
          .map((d) => d.name)
          .filter((name) => name.toLowerCase().endsWith('.nes'))
          .sort((a, b) => a.localeCompare(b));

        total = files.length;
        send({ scanId, type: 'start', folderPath, totalCount: total });

        for (const name of files) {
          const fullPath = path.join(folderPath, name);
          scanned++;
          try {
            const h = await readInesHeaderOnly(fullPath);
            if (h && h.isTargetMapper) {
              found++;
              const item = {
                filePath: fullPath,
                filename: name,
                prgBytes: h.prgBytes,
                chrBytes: h.chrBytes,
                mapperNumber: h.mapperNumber,
                mapperName: h.analysisMapper?.boardName || h.mapperName,
                isAnalysisSupported: h.isAnalysisSupported !== false,
                nromKind: h.nromKind,
                hasTrainer: h.hasTrainer,
                isInes2: h.isInes2
              };
              allFound.push(item);
              batch.push(item);
            }
          } catch {
            errors++;
          }

          if (batch.length >= 25) {
            send({
              scanId,
              type: 'batch',
              items: batch.splice(0, batch.length),
              scannedCount: scanned,
              totalCount: total,
              foundCount: found,
              errorCount: errors
            });
          }
        }

        if (batch.length) {
          send({
            scanId,
            type: 'batch',
            items: batch.splice(0, batch.length),
            scannedCount: scanned,
            totalCount: total,
            foundCount: found,
            errorCount: errors
          });
        }

        send({ scanId, type: 'done', scannedCount: scanned, totalCount: total, foundCount: found, errorCount: errors });

        romFolderCache = {
          version: ROM_FOLDER_CACHE_VERSION,
          folderPath,
          folderKey,
          items: allFound,
          meta: { scannedCount: scanned, totalCount: total, foundCount: found, errorCount: errors },
          savedAtMs: Date.now()
        };
        try {
          await saveRomFolderCache(romFolderCache);
        } catch {
          // Ignore persistence errors.
        }
      } catch (e) {
        send({ scanId, type: 'error', message: e?.message ?? String(e) });
      }
    })(), 0);

    return { ok: true, scanId };
  });


  ipcMain.handle('nesviz:openCdl', async () => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };

    const result = await dialog.showOpenDialog({
      title: 'Open CDL (Code/Data Log)',
      properties: ['openFile'],
      filters: [
        { name: 'CDL', extensions: ['cdl'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const filepath = result.filePaths[0];
    const buf = await fs.readFile(filepath);

    const sliced = sliceCdlForRom(new Uint8Array(buf), {
      prgSize: s.ines.prg.length,
      chrSize: s.ines.chr.length
    });

    s.cdl = {
      filepath,
      filename: path.basename(filepath),
      rawLength: buf.length,
      prg: sliced.prg,
      chr: sliced.chr,
      warnings: sliced.warnings
    };

    // CDL is loaded and stored, but not applied until the user runs analysis. 🤖
    // Clear any previous analysis results so the user doesn't confuse the old view with the CDL-applied view. 🤖
    clearActiveAnalysisState(s);

    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    return {
      ok: true,
      cdl: {
        filename: s.cdl.filename,
        rawLength: s.cdl.rawLength,
        prgBytes: s.cdl.prg ? s.cdl.prg.length : 0,
        chrBytes: s.cdl.chr ? s.cdl.chr.length : 0,
        warnings: s.cdl.warnings
      }
    };
  });

  ipcMain.handle('nesviz:runStaticAnalysis', async (evt) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    const m = s.ines.mapperNumber | 0;
    const prgSize = (s.ines?.prg?.length | 0) || 0;

    const isSupported = isStaticAnalysisSupportedHeader(s.ines);
    if (!isSupported) {
      return {
        ok: false,
        error: `Supported for static analysis: mapper 0 (NROM), mapper 1 (MMC1), mapper 2 (UxROM), mapper 94 (UN1ROM), CNROM (mappers 3 and 185), CPROM (13), AxROM (7), BNROM (34 BNROM only), and GxROM (66). ROM is mapper ${m} (PRG ${prgSize} bytes).`
      };
    }


    const mapperKind = getStaticAnalysisMapperKind(s.ines);

    await terminateActiveWorker();

    let workerResult;
    try {
      let thisWorker = null;

      workerResult = await runStaticAnalysisInWorker({
        prgBytes: s.ines.prg,
        vectors: s.vectors,
        mapperKind,
        mapperMeta: s.ines.analysisMapper || null,
        cdlPrg: s.cdl?.prg || null,
        cdlChr: s.cdl?.chr || null,
        cdlMeta: s.cdl ? { filename: s.cdl.filename, rawLength: s.cdl.rawLength, warnings: s.cdl.warnings } : null,
        tuningOverrides: { fixedSwitch16k: getTuningState(), mmc1: getTuningState() }
      }, {
        onWorker: (w) => {
          thisWorker = w;
          activeWorker = w;
        },
        onProgress: (msg) => {
          // Stream VSA progress to the renderer while analysis runs.
          try {
            evt.sender.send('nesviz:vsaProgress', {
              stableBlocks: msg?.stableBlocks,
              totalBlocks: msg?.totalBlocks,
              runId: msg?.runId
            });
          } catch {
            // Ignore send failures (window closed, etc).
          }
        }
      });

      // Only clear activeWorker if this run still owns it.
      if (activeWorker === thisWorker) activeWorker = null;
    } catch (err) {
      console.error('Static analysis worker failed:', err);
      return { ok: false, error: `Static analysis failed: ${err?.message || String(err)}` };
    }

    if (!workerResult?.ok) {
      const e = workerResult?.error || 'Static analysis failed';
      if (workerResult?.stack) console.error('Static analysis worker stack:', workerResult.stack);
      return { ok: false, error: e };
    }

    // If the user switched ROMs while analysis was running, discard these results.
    if (active !== s) return { ok: false, error: 'ROM changed during analysis' };

    applyAnalysisResultToActiveState(s, workerResult);

    try {
      await saveAnalysisCache(s.romHash, {
        raw: s.analysisRaw,
        analysis: s.analysis,
        blockAliases: s.blockAliases
      });
    } catch (err) {
      console.warn('Analysis cache save failed:', err);
    }

    try { notifyMemoryMapDataChanged(); } catch {}
    try { notifyGraphDataChanged(); } catch {}

    try {
      appendAnalysisLogLines(formatAnalysisLogLines({
        filename: s.filename,
        mapperKind: s.analysis?.mapper?.kind || mapperKind,
        analysis: s.analysis
      }));
    } catch {}

    return { ok: true, stats: s.analysis.stats };
  });

  ipcMain.handle('nesviz:getTimeline', async () => {
    const s = active;
    if (!s?.analysis) return { ok: false, error: 'No analysis loaded' };

    // Build an inbound-reference index for blocks. 🤖
    // We count only *explicit* control-flow references (branch/jump/call targets), not fallthroughs. 🤖
    // We also ignore self-loops (e.g., branch-to-self) to avoid reporting intra-block loops. 🤖
    const inboundByBlockId = buildInboundRefsByBlockId(s.analysis);

    const blocksIndex = s.analysis.blocks.map((b) => ({
      id: b.id,
      romStart: b.romStart,
      romEnd: b.romEnd,
      confidence: b.confidence,
      pills: Array.isArray(b.pills) ? b.pills : [],
      cpuStart: b.cpuStart ?? (b.lines?.[0]?.cpuAddr ?? null),
      cpuEnd: b.cpuEnd ?? null,
      instances: b.instances,
      inbound: {
        count: (inboundByBlockId.get(b.id) || []).length,
        sources: inboundByBlockId.get(b.id) || []
      },
      firstAsm: b.lines?.[0]?.asm || '',
      lineCount: b.lines?.length || 0,
      previewLines: (b.lines || []).slice(0, 8).map((ln) => ({
        siteKey: ln.siteKey || null,
        ctxKey: ln.ctxKey || null,
        backing: ln.backing || null,
        romOff: ln.romOff,
        cpuAddr: ln.cpuAddr,
        bytesText: ln.bytesText,
        asm: ln.asm,
        mnemonic: ln.mnemonic,
        mode: ln.mode,
        flow: ln.flow ? { type: ln.flow.type, target: ln.flow.target ?? null } : null
      }))
    }));
    return {
      ok: true,
      timeline: s.analysis.timeline,
      blocksIndex,
      blockAliases: s.blockAliases || {},
      mapper: s.analysis.mapper,
      stats: s.analysis.stats,
      debug: s.analysis.debug || null
    };
  });

  function buildInboundRefsByBlockId(analysis) {
    // Map each *decoded instruction start* (by CPU address) to its containing display block. 🤖
    // This lets us count inbounds that land in the *middle* of a coalesced block, not just at leaders. 🤖
    const cpuAddrToBlockId = new Map();
    for (const b of analysis.blocks) {
      for (const ln of b.lines || []) {
        if (typeof ln?.cpuAddr === 'number') cpuAddrToBlockId.set(ln.cpuAddr & 0xffff, b.id);
      }
    }

    // targetBlockId -> Map(dedupeKey -> entry) 🤖
    const inbound = new Map();

    for (const fromBlock of analysis.blocks) {
      for (const ln of fromBlock.lines || []) {
        const f = ln.flow;
        if (!f) continue;

        // Explicit references only. 🤖
        if (f.type !== 'branch' && f.type !== 'jump' && f.type !== 'call') continue;
        const targetCpu = f.target;
        if (typeof targetCpu !== 'number') continue;

        const toBlockId = cpuAddrToBlockId.get(targetCpu & 0xffff);
        if (!toBlockId) continue; // only if the target was decoded into a block leader. 🤖
        if (toBlockId === fromBlock.id) continue; // ignore self-loops / intra-block loops. 🤖

        let m = inbound.get(toBlockId);
        if (!m) {
          m = new Map();
          inbound.set(toBlockId, m);
        }

        // Deduplicate by physical ROM location if available; otherwise fall back to CPU address. 🤖
        const fromRomOff = typeof ln.romOff === 'number' ? ln.romOff : null;
        const fromCpuAddr = typeof ln.cpuAddr === 'number' ? ln.cpuAddr : null;
        const fromSiteKey = typeof ln.siteKey === 'string' ? ln.siteKey : null;
        const fromCtxKey = typeof ln.ctxKey === 'string' ? ln.ctxKey : null;
        const toCpuAddr = targetCpu & 0xffff;
        const key = fromSiteKey || (fromRomOff !== null ? `rom:${fromRomOff}` : `cpu:${fromCpuAddr}`);
        if (!m.has(key)) {
          m.set(key, { fromSiteKey, fromCtxKey, fromRomOff, fromCpuAddr, toCpuAddr });
        }
      }
    }

    // Flatten and sort for stable UI. 🤖
    const out = new Map();
    for (const [blockId, m] of inbound.entries()) {
      const arr = Array.from(m.values()).sort((a, b) => {
        const ac = a.fromCpuAddr ?? 0;
        const bc = b.fromCpuAddr ?? 0;
        return ac - bc;
      });
      out.set(blockId, arr);
    }
    return out;
  }

  ipcMain.handle('nesviz:getBlock', async (_evt, { blockId }) => {
    const s = active;
    if (!s?.analysis) return { ok: false, error: 'No analysis loaded' };
    const resolvedId = (s.blockAliases && s.blockAliases[blockId]) ? s.blockAliases[blockId] : blockId;
    const b = s.blockById?.get(resolvedId) || s.analysis.blocks.find((x) => x.id === resolvedId);
    if (!b) return { ok: false, error: 'Block not found' };
    return { ok: true, block: b };
  });

  ipcMain.handle('nesviz:getBlocks', async (_evt, { blockIds }) => {
    const s = active;
    if (!s?.analysis) return { ok: false, error: 'No analysis loaded' };
    if (!Array.isArray(blockIds)) return { ok: false, error: 'blockIds must be an array' };

    const byId = s.blockById || new Map(s.analysis.blocks.map((b) => [b.id, b]));
    const blocks = [];
    const missing = [];

    for (const id of blockIds) {
      if (!id) continue;
      const resolvedId = (s.blockAliases && s.blockAliases[id]) ? s.blockAliases[id] : id;
      const b = byId.get(resolvedId);
      if (b) blocks.push(b);
      else missing.push(id);
    }

    return { ok: true, blocks, missing };
  });

  ipcMain.handle('nesviz:getArtifacts', async () => {
    const s = active;
    if (!s?.analysis) return { ok: false, error: 'No analysis loaded' };
    return {
      ok: true,
      artifacts: s.analysis.artifacts,
      unresolvedSites: s.analysis.unresolvedSites,
      pointsOfInterest: s.analysis.pointsOfInterest || [],
      // VSA facts pass output (no UI yet). Exposed here for easy debugging in the renderer console.
      vsaFacts: s.analysis.vsaFacts || null,
      mapper: s.analysis.mapper,
      stats: s.analysis.stats,
      rom: { filename: s.filename, mapperNumber: s.ines.mapperNumber, prgSize: s.ines.prg.length }
    };
  });

  ipcMain.handle('nesviz:getGraphData', async () => {
    const s = active;
    if (!s?.ines) {
      return {
        ok: true,
        hasRom: false,
        hasAnalysis: false,
        nodes: [],
        edges: [],
        rom: null,
        mapper: null,
        stats: null
      };
    }

    const graph = buildGraphData({
      rawAnalysis: s.analysisRaw || null,
      coalescedAnalysis: s.analysis || null,
      blockAliases: s.blockAliases || null
    });

    return {
      ...graph,
      hasRom: true,
      rom: {
        filename: s.filename,
        mapperNumber: s.ines.mapperNumber,
        prgSize: s.ines.prg.length
      },
      mapper: s.analysis?.mapper || { kind: null, meta: s.ines.analysisMapper || null },
      stats: s.analysis?.stats || null
    };
  });

  ipcMain.handle('nesviz:getMemoryMapData', async () => {
    return buildMemoryMapDataForActive();
  });

  ipcMain.handle('nesviz:getPrgBytes', async (_evt, { romStart, romEnd }) => {
    const s = active;
    if (!s?.ines?.prg) return { ok: false, error: 'No ROM loaded' };
    const start = Number(romStart);
    const endNum = Number(romEnd);
    if (!Number.isFinite(start) || !Number.isFinite(endNum)) return { ok: false, error: 'Invalid range' };
    const a = Math.max(0, Math.min(s.ines.prg.length, start | 0));
    const b = Math.max(a, Math.min(s.ines.prg.length, endNum | 0));
    return { ok: true, romStart: a, romEnd: b, bytes: Array.from(s.ines.prg.subarray(a, b)) };
  });
}

// Expose a minimal view of the currently loaded ROM so other main-process services
// (e.g. Trace Streamer) can show metadata without inventing a session concept.
export function getActiveRomSummary() {
  const s = active;
  if (!s) return null;
  const ines = s.ines;
  return {
    filepath: s.filepath,
    filename: s.filename,
    romHash: s.romHash,
    ines: ines
      ? {
          format: ines.format,
          mapperNumber: ines.mapperNumber,
          prgSize: ines.prgSize,
          chrSize: ines.chrSize,
          mirroring: ines.mirroring,
          hasTrainer: !!ines.hasTrainer,
          hasBattery: !!ines.hasBattery,
          fourScreen: !!ines.fourScreen
        }
      : null
  };
}
