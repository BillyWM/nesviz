import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { parseInes, readVectorsFromLastPrgBank } from '../shared/rom/ines.js';
import { sliceCdlForRom } from '../shared/analyze/cdl/nesCdl.js';
import { updateRecentRoms } from './menu.js';
import {
  getBookmarksForRomHash,
  setBookmarkForRomHash,
  getLabelsForRomHash,
  setLabelForRomHash,
  getAddrLabelsForRomHash,
  setAddrLabelForRomHash,
  recordRecentRomPath
} from './userDataStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let nextFolderScanId = 1;

// Single-ROM app: the currently loaded ROM and its analysis state.
let active = null;

// If static analysis is running, this holds the active worker so we can terminate it when switching ROMs.
let activeWorker = null;

function runStaticNromInWorker(payload, opts = null) {
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
const ROM_FOLDER_CACHE_VERSION = 1;
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


    // Update recent ROMs (persisted in userData). This also refreshes the app menu.
    try {
      const recentRoms = await recordRecentRomPath(filepath, 10);
      updateRecentRoms(recentRoms);
    } catch {
      // Ignore recent list failures.
    }
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
      vectors
    };
  }

  async function readInesHeaderOnly(filepath) {
    const fh = await fs.open(filepath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const { bytesRead } = await fh.read(buf, 0, 16, 0);
      if (bytesRead < 16) return null;
      // iNES magic: 4E 45 53 1A
      if (buf[0] !== 0x4e || buf[1] !== 0x45 || buf[2] !== 0x53 || buf[3] !== 0x1a) return null;

      const prgUnits = buf[4] | 0;
      const chrUnits = buf[5] | 0;
      const flags6 = buf[6] | 0;
      const flags7 = buf[7] | 0;
      const mapperNumber = ((flags7 & 0xf0) | (flags6 >> 4)) & 0xff;

      const hasTrainer = (flags6 & 0x04) !== 0;
      const isInes2 = (flags7 & 0x0c) === 0x08;

      const prgBytes = prgUnits * 16384;
      const chrBytes = chrUnits * 8192;

      const mapperName =
        mapperNumber === 0 ? 'NROM'
          : mapperNumber === 1 ? 'MMC1'
            : (mapperNumber === 3 || mapperNumber === 185) ? 'CNROM'
            : mapperNumber === 4 ? 'MMC3'
              : `MAPPER ${mapperNumber}`;

      const isNrom = mapperNumber === 0;
      const isTargetMapper = mapperNumber === 0 || mapperNumber === 1 || mapperNumber === 3 || mapperNumber === 4 || mapperNumber === 185;

      const nromKind = isNrom
        ? prgBytes === 16384
          ? 'NROM-128'
          : prgBytes === 32768
            ? 'NROM-256'
            : 'NROM'
        : null;

      return {
        prgBytes,
        chrBytes,
        mapperNumber,
        mapperName,
        isTargetMapper,
        hasTrainer,
        isInes2,
        isNrom,
        nromKind
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

  ipcMain.handle('nesviz:getActiveLabels', async () => {
    const s = active;

    if (!s?.romHash) {
      return { ok: true, hasRom: false, labels: {}, addrLabels: {} };
    }

    const labels = await getLabelsForRomHash(s.romHash);
    const addrLabels = await getAddrLabelsForRomHash(s.romHash);
    return { ok: true, hasRom: true, romHash: s.romHash, labels, addrLabels };
  });

  ipcMain.handle('nesviz:setBookmark', async (_evt, { romOff, cpuAddr, set }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    const r = typeof romOff === 'number' ? romOff : Number(romOff);
    const c = (typeof cpuAddr === 'number') ? cpuAddr : (cpuAddr != null ? Number(cpuAddr) : null);
    if (!Number.isFinite(r) || r < 0) return { ok: false, error: 'Invalid romOff' };

    const next = await setBookmarkForRomHash(s.romHash, { romOff: r, cpuAddr: c }, !!set);
    return { ok: true, bookmarks: next };
  });

  ipcMain.handle('nesviz:setLabel', async (_evt, { romOff, label }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    const r = typeof romOff === 'number' ? romOff : Number(romOff);
    if (!Number.isFinite(r) || r < 0) return { ok: false, error: 'Invalid romOff' };

    const next = await setLabelForRomHash(s.romHash, r, label);
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
                mapperName: h.mapperName,
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
    s.analysisRaw = null;
    s.analysis = null;
    s.blockAliases = null;
    s.blockById = null;

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

  ipcMain.handle('nesviz:runStaticNrom', async (evt) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    const m = s.ines.mapperNumber | 0;
    const prgSize = (s.ines?.prg?.length | 0) || 0;

    // Static analysis currently assumes an NROM-like, fixed CPU->PRG mapping.
    // Allow MMC1 only for small PRG sizes (<= 32KiB), since those ROMs can run entirely
    // within a single 32KiB PRG view (i.e., no additional banks to page in).
    // NOTE: This exception is *only* for MMC1; MMC3 is still unsupported here.
    const isSupported = m === 0 || m === 3 || m === 185 || (m === 1 && prgSize <= (32 * 1024));
    if (!isSupported) {
      return {
        ok: false,
        error: `Supported for static analysis: mapper 0 (NROM), CNROM (mappers 3 and 185), and MMC1 only when PRG is 32KiB or smaller. ROM is mapper ${m} (PRG ${prgSize} bytes).`
      };
    }

    // Our current mapper model only supports 16KiB or 32KiB PRG under the NROM mapping.
    if (m === 1 && !(prgSize === (16 * 1024) || prgSize === (32 * 1024))) {
      return {
        ok: false,
        error: `MMC1 static analysis is only supported for 16KiB or 32KiB PRG. ROM is mapper ${m} (PRG ${prgSize} bytes).`
      };
    }

    const mapperKind = (m === 3 || m === 185) ? 'CNROM' : 'NROM';

    let workerResult;
    try {
      let thisWorker = null;
      // If analysis is already running, stop it (single-ROM, single-analysis).
      await terminateActiveWorker();

      workerResult = await runStaticNromInWorker({
        prgBytes: s.ines.prg,
        vectors: s.vectors,
        mapperKind,
        cdlPrg: s.cdl?.prg || null,
        cdlChr: s.cdl?.chr || null,
        cdlMeta: s.cdl ? { filename: s.cdl.filename, rawLength: s.cdl.rawLength, warnings: s.cdl.warnings } : null
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

    const { raw, analysis, blockAliases } = workerResult;
    s.analysisRaw = raw;
    s.analysis = analysis;
    s.blockAliases = blockAliases;

    // Index blocks for cheap block lookups (getBlock/getBlocks). 🤖
    s.blockById = new Map(analysis.blocks.map((b) => [b.id, b]));

    return { ok: true, stats: analysis.stats };
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
        const toCpuAddr = targetCpu & 0xffff;
        const key = fromRomOff !== null ? `rom:${fromRomOff}` : `cpu:${fromCpuAddr}`;
        if (!m.has(key)) {
          m.set(key, { fromRomOff, fromCpuAddr, toCpuAddr });
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
}
