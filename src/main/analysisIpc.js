import { app, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { parseInes, readVectorsFromLastPrgBank } from '../shared/rom/ines.js';
import { getStaticAnalysisSupportInfo } from '../shared/rom/mapperInfo.js';
import { parseNesCdl } from '../shared/analyze/cdl/nesCdl.js';
import { updateRecentRoms } from './menu.js';
import { appendAnalysisLogLines } from './analysisLogWindow.js';
import { getTuningState } from './tuningState.js';
import { resolveDiscoveredVectorDestinationsByFamily } from '../shared/analyze/vectorNavigation.js';
import { notifyAnalysisDataChanged } from './analysisDataEvents.js';
import { hasAnalysisCache, loadAnalysisCache, saveAnalysisCache } from './analysisCache.js';
import { invalidateAnalysisArtifacts } from './analysisInvalidation.js';
import { fmtHexRange } from '../shared/utils/numberUtils.js';
import { buildVsaLineDebugForBlock } from '../shared/analyze/vsa/lineDebug.js';
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

function getStaticAnalysisInfoForMapperMeta(analysisMapper) {
  return getStaticAnalysisSupportInfo(analysisMapper || null);
}

function getStaticAnalysisInfoForHeader(header) {
  return getStaticAnalysisInfoForMapperMeta(header?.analysisMapper || null);
}

function clearActiveAnalysisState(s) {
  if (!s) return;
  s.rawAnalysis = null;
  s.displayAnalysis = null;
  s.rawToDisplayBlockIds = null;
  s.blockById = null;
}

function getVectorDestinationsByFamilyForActive(s) {
  if (!s?.ines?.prg || !s?.displayAnalysis?.blocks || !s?.vectors) return null;
  return resolveDiscoveredVectorDestinationsByFamily({
    prgBytes: s.ines.prg,
    vectors: s.vectors,
    mapperKind: s.displayAnalysis?.mapper?.kind || 'NROM',
    mapperMeta: s.displayAnalysis?.mapper?.meta || s.ines?.analysisMapper || null,
    blocks: s.displayAnalysis.blocks
  });
}

function applyAnalysisResultToActiveState(s, result) {
  if (!s) throw new Error('No active ROM');
  const rawAnalysis = result?.rawAnalysis ?? null;
  const displayAnalysis = result?.displayAnalysis ?? null;
  const rawToDisplayBlockIds = result?.rawToDisplayBlockIds ?? null;
  if (!displayAnalysis || !Array.isArray(displayAnalysis.blocks)) {
    throw new Error('Invalid analysis payload');
  }
  s.rawAnalysis = rawAnalysis;
  s.displayAnalysis = displayAnalysis;
  s.rawToDisplayBlockIds = rawToDisplayBlockIds;
  s.blockById = new Map(displayAnalysis.blocks.map((b) => [b.id, b]));
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

async function terminateActiveWorker() {
  const w = activeWorker;
  if (!w) return;
  activeWorker = null;
  try {
    await w.terminate();
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


function serializeFlowForRenderer(flow) {
  if (!flow || typeof flow !== 'object') return null;
  const out = {
    type: typeof flow.type === 'string' ? flow.type : null
  };
  if (typeof flow.target === 'number') out.target = flow.target & 0xffff;
  if (typeof flow.fallthrough === 'number') out.fallthrough = flow.fallthrough & 0xffff;
  if (typeof flow.next === 'number') out.next = flow.next & 0xffff;
  if (typeof flow.targetRomOff === 'number') out.targetRomOff = flow.targetRomOff >>> 0;
  if (typeof flow.fallthroughRomOff === 'number') out.fallthroughRomOff = flow.fallthroughRomOff >>> 0;
  if (typeof flow.nextRomOff === 'number') out.nextRomOff = flow.nextRomOff >>> 0;
  return out;
}

function lineBoundaryKey(ln) {
  if (!ln || typeof ln !== 'object') return null;
  if (typeof ln.romOff !== 'number') return null;
  const len = (typeof ln.len === 'number' && ln.len > 0) ? (ln.len >>> 0) : 1;
  return `${ln.romOff >>> 0}:${len}`;
}

function buildRawBlockById(rawAnalysis) {
  const out = new Map();
  const blocks = Array.isArray(rawAnalysis?.blocks) ? rawAnalysis.blocks : [];
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    out.set(block.id, block);
  }
  return out;
}

function rawCfgBlockEndKindsForDisplayBlock(displayBlock, rawBlockById) {
  const out = new Map();
  if (!displayBlock || !rawBlockById || typeof rawBlockById.get !== 'function') return out;

  const displayLineKeys = new Set();
  for (const ln of displayBlock.lines || []) {
    const key = lineBoundaryKey(ln);
    if (key) displayLineKeys.add(key);
  }

  for (const rawBlockId of displayBlock.rawBlockIds || []) {
    if (typeof rawBlockId !== 'string' || !rawBlockId) continue;
    const rawBlock = rawBlockById.get(rawBlockId);
    const rawLines = Array.isArray(rawBlock?.lines) ? rawBlock.lines : [];
    const lastLine = rawLines.length > 0 ? rawLines[rawLines.length - 1] : null;
    const key = lineBoundaryKey(lastLine);
    if (!key || !displayLineKeys.has(key)) continue;

    out.set(key, rawBlock.confidence === 'probable' ? 'probable' : 'certain');
  }

  return out;
}

function serializeLineForRenderer(ln, opts = null) {
  if (!ln || typeof ln !== 'object') return null;
  const out = {
    backing: ln.backing || null,
    romOff: typeof ln.romOff === 'number' ? (ln.romOff >>> 0) : null,
    cpuAddr: typeof ln.cpuAddr === 'number' ? (ln.cpuAddr & 0xffff) : null,
    len: typeof ln.len === 'number' ? (ln.len >>> 0) : null,
    bytesText: typeof ln.bytesText === 'string' ? ln.bytesText : '',
    asm: typeof ln.asm === 'string' ? ln.asm : '',
    mnemonic: typeof ln.mnemonic === 'string' ? ln.mnemonic : '',
    mode: typeof ln.mode === 'string' ? ln.mode : null,
    confidence: ln.confidence === 'probable' ? 'probable' : 'certain',
    flow: serializeFlowForRenderer(ln.flow)
  };
  const key = lineBoundaryKey(ln);
  const rawCfgBlockEndKind = key ? opts?.rawCfgBlockEndKinds?.get(key) : null;
  if (rawCfgBlockEndKind) {
    out.rawCfgBlockEnd = true;
    out.rawCfgBlockEndKind = rawCfgBlockEndKind === 'probable' ? 'probable' : 'certain';
  }
  return out;
}

function serializeProbablePromotionDebug(debug) {
  const entries = Array.isArray(debug?.entries) ? debug.entries : [];
  const outEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const out = {};

    if (typeof entry.rawBlockId === 'string' && entry.rawBlockId) out.rawBlockId = entry.rawBlockId;
    if (typeof entry.romStart === 'number') out.romStart = entry.romStart >>> 0;
    if (typeof entry.romEnd === 'number') out.romEnd = entry.romEnd >>> 0;
    if (typeof entry.cpuStart === 'number') out.cpuStart = entry.cpuStart & 0xffff;
    if (typeof entry.acceptedReason === 'string' && entry.acceptedReason) out.acceptedReason = entry.acceptedReason;
    if (typeof entry.acceptedReasonLabel === 'string' && entry.acceptedReasonLabel) out.acceptedReasonLabel = entry.acceptedReasonLabel;
    if (Array.isArray(entry.evidenceKinds) && entry.evidenceKinds.length) {
      out.evidenceKinds = entry.evidenceKinds.filter((value) => typeof value === 'string' && value);
    }
    if (Array.isArray(entry.evidenceLabels) && entry.evidenceLabels.length) {
      out.evidenceLabels = entry.evidenceLabels.filter((value) => typeof value === 'string' && value);
    }

    if (Object.keys(out).length > 0) outEntries.push(out);
  }

  return outEntries.length > 0 ? { entries: outEntries } : null;
}

function serializeBlockForRenderer(block, opts = null) {
  if (!block || typeof block !== 'object') return null;
  const {
    siteKey: _siteKey,
    ctxKey: _ctxKey,
    lines: _lines,
    probablePromotionDebug: _probablePromotionDebug,
    ...rest
  } = block;
  const rawCfgBlockEndKinds = rawCfgBlockEndKindsForDisplayBlock(block, opts?.rawBlockById);
  const out = {
    ...rest,
    lines: Array.isArray(block.lines)
      ? block.lines.map((line) => serializeLineForRenderer(line, { rawCfgBlockEndKinds })).filter(Boolean)
      : []
  };
  const probablePromotionDebug = serializeProbablePromotionDebug(block.probablePromotionDebug);
  if (probablePromotionDebug) out.probablePromotionDebug = probablePromotionDebug;
  return out;
}

function stripNavigationIdentityFields(value) {
  if (Array.isArray(value)) return value.map(stripNavigationIdentityFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'siteKey' || key === 'ctxKey' || key === 'fetchCtx') continue;
    if (key === 'rawBlockId' || key === 'siteRawBlockId') continue;
    if (key === 'anchorBlockId' || key === 'anchorRomOff' || key === 'anchorCpuAddr') continue;
    out[key] = stripNavigationIdentityFields(item);
  }
  return out;
}

function serializeUnresolvedSiteForRenderer(site) {
  if (!site || site.kind !== 'jmp_ind') return null;
  const romOff = typeof site.romOff === 'number' ? (site.romOff >>> 0) : null;
  if (romOff === null) return null;
  return {
    kind: 'jmp_ind',
    romOff,
    pc: typeof site.pc === 'number' ? (site.pc & 0xffff) : null,
    ptrAddr: typeof site.ptrAddr === 'number' ? (site.ptrAddr & 0xffff) : null
  };
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
      rawAnalysis: null,

      displayAnalysis: null,
      rawToDisplayBlockIds: null,
      blockById: null,
      heatmapCache: null
    };

    let hasCachedAnalysis = false;
    try {
      hasCachedAnalysis = await hasAnalysisCache(romHash);
    } catch (err) {
      console.warn('Analysis cache existence check failed while opening ROM; ignoring cached analysis:', err);
    }

    // Update recent ROMs (persisted in userData). This also refreshes the app menu.
    try {
      const recentRoms = await recordRecentRomPath(filepath, 10);
      updateRecentRoms(recentRoms);
    } catch {
      // Ignore recent list failures.
    }
    try { notifyAnalysisDataChanged(); } catch {}

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
      hasCachedAnalysis
    };
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

  ipcMain.handle('nesviz:loadActiveAnalysisCache', async () => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    let cachedResult;
    try {
      cachedResult = await loadAnalysisCache(s.romHash);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        clearActiveAnalysisState(s);
        try { notifyAnalysisDataChanged(); } catch {}
        return { ok: true, hasCachedAnalysis: false };
      }
      console.warn('Analysis cache load failed for active ROM:', err);
      return { ok: false, error: `Cached analysis load failed: ${err?.message || String(err)}` };
    }

    try {
      applyAnalysisResultToActiveState(s, cachedResult);
    } catch (err) {
      console.warn('Cached analysis payload was invalid for active ROM:', err);
      return { ok: false, error: `Cached analysis was invalid: ${err?.message || String(err)}` };
    }

    try { notifyAnalysisDataChanged(); } catch {}

    return {
      ok: true,
      hasCachedAnalysis: true,
      stats: s.displayAnalysis?.stats || null
    };
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

  ipcMain.handle('nesviz:setBookmarkAtRomOff', async (_evt, { romOff, set }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };
    const off = typeof romOff === 'number' ? romOff : Number(romOff);
    if (!Number.isFinite(off) || off < 0) return { ok: false, error: 'Invalid romOff' };

    const next = await setBookmarkForRomHash(s.romHash, off, !!set);
    return { ok: true, bookmarks: next };
  });

  ipcMain.handle('nesviz:setRomLabel', async (_evt, { romOff, label }) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };
    const off = typeof romOff === 'number' ? romOff : Number(romOff);
    if (!Number.isFinite(off) || off < 0) return { ok: false, error: 'Invalid romOff' };

    const next = await setLabelForRomHash(s.romHash, off, label);
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

    const parsed = parseNesCdl(new Uint8Array(buf), {
      prgSize: s.ines.prg.length,
      chrSize: s.ines.chr.length
    });

    if (!parsed.ok) {
      return { ok: false, error: parsed.warnings?.[0] || 'Failed to parse CDL.' };
    }

    s.cdl = {
      filepath,
      filename: path.basename(filepath),
      format: parsed.format,
      rawLength: buf.length,
      prg: parsed.prg,
      chr: parsed.chr,
      warnings: parsed.warnings,
      header: parsed.header || null
    };

    // CDL is loaded and stored, but not applied until the user runs analysis. 🤖
    // Clear any previous analysis results so the user doesn't confuse the old view with the CDL-applied view. 🤖
    clearActiveAnalysisState(s);

    try {
      await invalidateAnalysisArtifacts(s.romHash);
    } catch (err) {
      console.warn('Analysis artifact invalidation failed after loading CDL:', err);
    }

    try { notifyAnalysisDataChanged(); } catch {}

    return {
      ok: true,
      cdl: {
        filename: s.cdl.filename,
        format: s.cdl.format,
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

    const analysisInfo = getStaticAnalysisInfoForHeader(s.ines);
    if (!analysisInfo.isAnalyzable) {
      return {
        ok: false,
        error: `Supported for static analysis: mapper 0 (NROM), mapper 1 (MMC1), mapper 2 (UxROM), mapper 4 (MMC3), mapper 94 (UN1ROM), CNROM (mappers 3 and 185), CPROM (13), AxROM (7), BNROM (34 BNROM only), and GxROM (66). ROM is mapper ${m} (PRG ${prgSize} bytes).`
      };
    }


    const mapperKind = analysisInfo.analysisKind;

    try {
      await invalidateAnalysisArtifacts(s.romHash);
    } catch (err) {
      console.warn('Analysis artifact invalidation failed before static analysis:', err);
    }

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
        cdlMeta: s.cdl ? { filename: s.cdl.filename, format: s.cdl.format, rawLength: s.cdl.rawLength, warnings: s.cdl.warnings } : null,
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
        rawAnalysis: s.rawAnalysis,
        displayAnalysis: s.displayAnalysis,
        rawToDisplayBlockIds: s.rawToDisplayBlockIds
      });
    } catch (err) {
      console.warn('Analysis cache save failed:', err);
    }

    try { notifyAnalysisDataChanged(); } catch {}

    try {
      appendAnalysisLogLines(formatAnalysisLogLines({
        filename: s.filename,
        mapperKind: s.displayAnalysis?.mapper?.kind || mapperKind,
        analysis: s.displayAnalysis
      }));
    } catch {}

    return { ok: true, stats: s.displayAnalysis.stats };
  });

  ipcMain.handle('nesviz:getTimeline', async () => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };

    // Build an inbound-reference index for blocks. 🤖
    // We count only *explicit* control-flow references (branch/jump/call targets), not fallthroughs. 🤖
    // We also ignore self-loops (e.g., branch-to-self) to avoid reporting intra-block loops. 🤖
    const inboundByBlockId = buildInboundRefsByBlockId(s.displayAnalysis);
    const rawBlockById = buildRawBlockById(s.rawAnalysis);

    const blocksIndex = s.displayAnalysis.blocks.map((b) => {
      const rawCfgBlockEndKinds = rawCfgBlockEndKindsForDisplayBlock(b, rawBlockById);
      return {
      id: b.id,
      romStart: b.romStart,
      romEnd: b.romEnd,
      confidence: b.confidence,
      pills: Array.isArray(b.pills) ? b.pills : [],
      cpuStart: b.cpuStart ?? (b.lines?.[0]?.cpuAddr ?? null),
      cpuEnd: b.cpuEnd ?? null,
      inbound: {
        count: (inboundByBlockId.get(b.id) || []).length,
        sources: inboundByBlockId.get(b.id) || []
      },
      probablePromotionDebug: serializeProbablePromotionDebug(b.probablePromotionDebug),
      firstAsm: b.lines?.[0]?.asm || '',
      lineCount: b.lines?.length || 0,
      previewLines: (b.lines || []).slice(0, 8).map((line) => serializeLineForRenderer(line, { rawCfgBlockEndKinds })).filter(Boolean)
      };
    });
    return {
      ok: true,
      timeline: s.displayAnalysis.timeline,
      blocksIndex,
      mapper: s.displayAnalysis.mapper,
      stats: s.displayAnalysis.stats,
      debug: null,
      vectorDestinationsByFamily: getVectorDestinationsByFamilyForActive(s)
    };
  });

  function buildInboundRefsByBlockId(analysis) {
    const romOffToBlockId = new Map();
    for (const b of analysis.blocks || []) {
      for (const ln of b.lines || []) {
        if (typeof ln?.romOff === 'number') romOffToBlockId.set(ln.romOff >>> 0, b.id);
      }
    }

    const inbound = new Map();

    for (const fromBlock of analysis.blocks || []) {
      for (const ln of fromBlock.lines || []) {
        const f = ln.flow;
        if (!f) continue;
        if (f.type !== 'branch' && f.type !== 'jump' && f.type !== 'call') continue;
        if (typeof f.targetRomOff !== 'number') continue;
        if (typeof ln.romOff !== 'number') continue;

        const toRomOff = f.targetRomOff >>> 0;
        const toBlockId = romOffToBlockId.get(toRomOff);
        if (!toBlockId || toBlockId === fromBlock.id) continue;

        let m = inbound.get(toBlockId);
        if (!m) {
          m = new Map();
          inbound.set(toBlockId, m);
        }

        const fromRomOff = ln.romOff >>> 0;
        const key = `rom:${fromRomOff}`;
        if (!m.has(key)) {
          m.set(key, {
            fromRomOff,
            fromCpuAddr: typeof ln.cpuAddr === 'number' ? (ln.cpuAddr & 0xffff) : null,
            toRomOff,
            toCpuAddr: typeof f.target === 'number' ? (f.target & 0xffff) : null
          });
        }
      }
    }

    const out = new Map();
    for (const [blockId, m] of inbound.entries()) {
      const arr = Array.from(m.values()).sort((a, b) => a.fromRomOff - b.fromRomOff);
      out.set(blockId, arr);
    }
    return out;
  }

  ipcMain.handle('nesviz:getBlock', async (_evt, { blockId }) => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    const b = s.blockById?.get(blockId) || s.displayAnalysis.blocks.find((x) => x.id === blockId);
    if (!b) return { ok: false, error: 'Display block not found' };
    return { ok: true, block: serializeBlockForRenderer(b, { rawBlockById: buildRawBlockById(s.rawAnalysis) }) };
  });

  ipcMain.handle('nesviz:getBlockVsaDebug', async (_evt, { blockId }) => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    const b = s.blockById?.get(blockId) || s.displayAnalysis.blocks.find((x) => x.id === blockId);
    if (!b) return { ok: false, error: 'Display block not found' };
    const debug = buildVsaLineDebugForBlock({ block: b, observationsResult: s.displayAnalysis.vsaFacts || null });
    return { ok: true, debug };
  });

  ipcMain.handle('nesviz:getBlocks', async (_evt, { blockIds }) => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    if (!Array.isArray(blockIds)) return { ok: false, error: 'blockIds must be an array' };

    const byId = s.blockById || new Map(s.displayAnalysis.blocks.map((b) => [b.id, b]));
    const blocks = [];
    const missing = [];

    for (const id of blockIds) {
      if (!id) continue;
      const b = byId.get(id);
      if (b) blocks.push(b);
      else missing.push(id);
    }

    const rawBlockById = buildRawBlockById(s.rawAnalysis);
    return { ok: true, blocks: blocks.map((block) => serializeBlockForRenderer(block, { rawBlockById })).filter(Boolean), missing };
  });

  ipcMain.handle('nesviz:getArtifacts', async () => {
    const s = active;
    if (!s?.displayAnalysis) return { ok: false, error: 'No analysis loaded' };
    return {
      ok: true,
      artifacts: (s.displayAnalysis.artifacts || []).map(stripNavigationIdentityFields),
      unresolvedSites: (s.displayAnalysis.unresolvedSites || []).map(serializeUnresolvedSiteForRenderer).filter(Boolean),
      pointsOfInterest: (s.displayAnalysis.pointsOfInterest || []).map(stripNavigationIdentityFields),
      // VSA facts pass output (no UI yet). Exposed here for easy debugging in the renderer console.
      vsaFacts: s.displayAnalysis.vsaFacts || null,
      mapper: s.displayAnalysis.mapper,
      stats: s.displayAnalysis.stats,
      rom: { filename: s.filename, mapperNumber: s.ines.mapperNumber, prgSize: s.ines.prg.length }
    };
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


export function getActiveAnalysisState() {
  return active;
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
