import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import {
  ANALYSIS_PHASE_IDS,
  ANALYSIS_PROGRESS_DETAIL_KINDS,
  FUNCTION_EXCAVATION_PROGRESS_CHUNK_BYTES
} from '../analysisConstants.js';
import { decodeInstructionAtSite } from '../cfg/decode.js';
import { requireArray, requireInteger, requireObject } from '../dataShape.js';
import { decodeForwardToHardTerminator } from './decodeForward.js';
import { controllerReadRecognizer } from './controllerReadRecognizer.js';
import { mmc1SerialWriteRecognizer } from './mmc1SerialWriteRecognizer.js';
import { ppuAccessRecognizers } from './ppuAccessRecognizer.js';
import {
  decodeRawForwardToAnyRomOff,
  decodeRawForwardToHardTerminator,
  readRawU16le
} from './rawDecode.js';

const PROMOTE_ALL_CANDIDATES = true;
const DIRECT_PROMOTION_CHUNK_ISLANDS = 16;

function makeCounters() {
  return {
    scannedRomOffsets: 0,
    islandScanRomOffsets: 0,
    frontierScanRomOffsets: 0,
    anchorAttempts: 0,
    anchors: 0,
    islands: 0,
    frontiers: 0,
    candidates: 0,
    rejected: 0,
    duplicateSeeds: 0,
    addedSeeds: 0,
    acceptedCodeSpans: 0,
    possibleAppearances: 0,
    byKind: {}
  };
}

function makeKindCounters() {
  return {
    candidates: 0,
    promoted: 0
  };
}

function cloneKindCounters(byKind) {
  const out = {};
  if (!byKind || typeof byKind !== 'object') return out;
  for (const [kind, counters] of Object.entries(byKind)) {
    const candidateCount = counters && Number.isFinite(counters.candidates) ? (counters.candidates >>> 0) : 0;
    const promotedCount = counters && Number.isFinite(counters.promoted) ? (counters.promoted >>> 0) : 0;
    out[kind] = {
      candidates: candidateCount,
      promoted: promotedCount
    };
  }
  return out;
}

function cloneSite(site) {
  requireObject(site, 'function excavation site');
  return {
    mapperContext: requireObject(site.mapperContext, 'function excavation site.mapperContext'),
    contextKey: String(site.contextKey),
    siteKey: String(site.siteKey),
    cpuAddr: requireInteger(site.cpuAddr, 'function excavation site.cpuAddr') & 0xffff,
    romOff: requireInteger(site.romOff, 'function excavation site.romOff') >>> 0,
    backing: requireObject(site.backing, 'function excavation site.backing')
  };
}

function cloneAppearance(site) {
  requireObject(site, 'function excavation appearance');
  return {
    contextKey: String(site.contextKey),
    siteKey: String(site.siteKey),
    cpuAddr: requireInteger(site.cpuAddr, 'function excavation appearance.cpuAddr') & 0xffff,
    romOff: requireInteger(site.romOff, 'function excavation appearance.romOff') >>> 0,
    backing: requireObject(site.backing, 'function excavation appearance.backing')
  };
}

function sitesForRomOff(mapper, romOff, purpose = 'functionExcavationFrontierAppearance') {
  if (typeof mapper.codeSitesForRomOff !== 'function') return [];
  const sites = mapper.codeSitesForRomOff(romOff >>> 0, { purpose });
  return Array.isArray(sites) ? sites : [];
}

function isRawDirectControlFrontierStart(prgBytes, romOff) {
  const off = romOff >>> 0;
  if (off + 2 >= prgBytes.length) return false;
  const opcode = prgBytes[off] & 0xff;
  return opcode === 0x20 || opcode === 0x4c;
}

function rawFrontierKind(prgBytes, romOff) {
  return (prgBytes[romOff >>> 0] & 0xff) === 0x20 ? 'jsr' : 'jmp';
}

const EXCAVATION_RECOGNIZERS = Object.freeze([
  controllerReadRecognizer,
  mmc1SerialWriteRecognizer,
  ...ppuAccessRecognizers
]);

function activeRecognizersForContext(context) {
  return EXCAVATION_RECOGNIZERS.filter((recognizer) => {
    if (!recognizer || typeof recognizer !== 'object') throw new Error('function excavation recognizer must be an object');
    if (typeof recognizer.kind !== 'string' || recognizer.kind.length === 0) throw new Error('function excavation recognizer must have a kind');
    if (typeof recognizer.isAnchorStart !== 'function') throw new Error(`function excavation recognizer ${recognizer.kind} must provide isAnchorStart`);
    if (typeof recognizer.tryMatch !== 'function') throw new Error(`function excavation recognizer ${recognizer.kind} must provide tryMatch`);
    if (typeof recognizer.isEnabled !== 'function') return true;
    return recognizer.isEnabled(context) === true;
  });
}

function isDecodedMatchingRawFrontier(instruction, rawFrontier) {
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry || entry.mode !== AM.ABSOLUTE) return false;
  if ((instruction.operand & 0xffff) !== (rawFrontier.targetCpuAddr & 0xffff)) return false;
  if (rawFrontier.kind === 'jsr') return entry.mnemonic === 'JSR';
  if (rawFrontier.kind === 'jmp') return entry.mnemonic === 'JMP';
  return false;
}

function makeAnchor(anchorId, match) {
  return {
    anchorId,
    kind: match.kind,
    recognitionMode: match.recognitionMode,
    valueProof: match.valueProof,
    anchorStartRomOff: match.anchorStartRomOff >>> 0,
    anchorEndRomOff: match.anchorEndRomOff >>> 0,
    evidenceRomOffs: requireArray(match.evidenceRomOffs, 'function excavation anchor.evidenceRomOffs').map((item) => item >>> 0),
    evidence: requireObject(match.evidence, 'function excavation anchor.evidence'),
    strength: String(match.strength || 'candidate')
  };
}

function decodeRawIsland({ prgBytes, anchor }) {
  const decoded = decodeRawForwardToHardTerminator({
    prgBytes,
    startRomOff: anchor.anchorStartRomOff >>> 0
  });
  if (!decoded.ok) return { ok: false, reason: decoded.reason, detail: decoded.detail || null };
  const entries = decoded.entries;
  const last = entries[entries.length - 1].instruction;
  return {
    ok: true,
    island: {
      islandId: `island:${anchor.anchorId}`,
      anchorId: anchor.anchorId,
      kind: anchor.kind,
      recognitionMode: anchor.recognitionMode,
      decodeStartRomOff: anchor.anchorStartRomOff >>> 0,
      anchorEndRomOff: anchor.anchorEndRomOff >>> 0,
      decodeEndRomOff: (last.romOff + last.size) >>> 0,
      terminatorRomOff: last.romOff >>> 0,
      evidenceRomOffs: anchor.evidenceRomOffs.slice(),
      evidence: anchor.evidence,
      instructionRomOffs: entries.map((entry) => entry.instruction.romOff >>> 0)
    }
  };
}

function makeRawFrontier(frontierId, prgBytes, romOff) {
  return {
    frontierId,
    kind: rawFrontierKind(prgBytes, romOff),
    sourceRomOff: romOff >>> 0,
    targetCpuAddr: readRawU16le(prgBytes, (romOff >>> 0) + 1)
  };
}

export function createFunctionExcavationPhase(context, options = null) {
  const result = {
    anchors: [],
    islands: [],
    frontiers: [],
    candidates: [],
    acceptedCodeSpans: [],
    rejected: [],
    counters: makeCounters()
  };

  const phaseOptions = options && typeof options === 'object' ? options : {};
  const scanChunkBytes = Number.isInteger(phaseOptions.scanChunkBytes) && phaseOptions.scanChunkBytes > 0
    ? phaseOptions.scanChunkBytes
    : FUNCTION_EXCAVATION_PROGRESS_CHUNK_BYTES;

  const activeRecognizers = activeRecognizersForContext(context);
  for (const recognizer of activeRecognizers) {
    result.counters.byKind[recognizer.kind] = makeKindCounters();
  }

  const seenAnchors = new Set();
  const seenFrontiers = new Set();
  const promotedCandidateKeys = new Set();
  const promotedIslandIds = new Set();
  const entryReachCache = new Map();
  const islandsByStartRomOff = new Map();
  const islandStartRomOffs = new Set();
  let islandScanRomOff = 0;
  let islandScanComplete = false;
  let frontierScanRomOff = 0;
  let frontierScanComplete = false;
  let directPromotionIslandIndex = 0;
  let directPromotionComplete = !PROMOTE_ALL_CANDIDATES;
  let finalized = false;
  let progressStage = 'islandScan';

  function progressDetails() {
    const totalBytes = context.prgBytes.length >>> 0;
    const scannedBytes = progressStage === 'frontierScan'
      ? Math.min(frontierScanRomOff >>> 0, totalBytes)
      : Math.min(islandScanRomOff >>> 0, totalBytes);
    return {
      stage: progressStage,
      scannedBytes,
      totalBytes,
      candidates: result.counters.candidates >>> 0,
      promoted: result.counters.addedSeeds >>> 0,
      byKind: cloneKindCounters(result.counters.byKind)
    };
  }

  function progressPayload() {
    return {
      phase: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
      detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.FUNCTION_EXCAVATION,
      details: progressDetails(),
      ...result.counters
    };
  }

  function recordIsland(island) {
    result.islands.push(island);
    result.counters.islands = result.islands.length;
    const startRomOff = island.decodeStartRomOff >>> 0;
    const islandsAtStart = islandsByStartRomOff.get(startRomOff);
    if (islandsAtStart) islandsAtStart.push(island);
    else islandsByStartRomOff.set(startRomOff, [island]);
    islandStartRomOffs.add(island.decodeStartRomOff >>> 0);
  }

  function scanIslandsChunk() {
    const prgBytes = context.prgBytes;
    const endRomOff = Math.min(islandScanRomOff + scanChunkBytes, prgBytes.length);

    for (let romOff = islandScanRomOff; romOff < endRomOff; romOff += 1) {
      result.counters.scannedRomOffsets += 1;
      result.counters.islandScanRomOffsets += 1;

      for (const recognizer of activeRecognizers) {
        if (!recognizer.isAnchorStart(prgBytes, romOff)) continue;

        result.counters.anchorAttempts += 1;
        const match = recognizer.tryMatch({ prgBytes, startRomOff: romOff, context });
        if (!match) continue;
        if (match.kind !== recognizer.kind) {
          throw new Error(`function excavation recognizer ${recognizer.kind} returned mismatched kind ${match.kind}`);
        }

        const anchorKey = `${match.kind}:${match.anchorStartRomOff >>> 0}:${match.anchorEndRomOff >>> 0}`;
        if (seenAnchors.has(anchorKey)) continue;
        seenAnchors.add(anchorKey);

        const anchor = makeAnchor(`anchor:${result.anchors.length}`, match);
        result.anchors.push(anchor);
        result.counters.anchors = result.anchors.length;

        const islandResult = decodeRawIsland({ prgBytes, anchor });
        if (!islandResult.ok) {
          result.rejected.push({
            kind: 'island',
            anchorId: anchor.anchorId,
            reason: islandResult.reason,
            detail: islandResult.detail || null
          });
          result.counters.rejected = result.rejected.length;
          continue;
        }

        recordIsland(islandResult.island);
        continue;
      }
    }

    islandScanRomOff = endRomOff;
    if (islandScanRomOff >= prgBytes.length) islandScanComplete = true;
  }

  function islandsReachedFromEntryRomOff(entryRomOff) {
    const entry = entryRomOff >>> 0;
    if (entryReachCache.has(entry)) return entryReachCache.get(entry);
    if (!islandStartRomOffs.size) {
      entryReachCache.set(entry, []);
      return [];
    }

    const rawDecoded = decodeRawForwardToAnyRomOff({
      prgBytes: context.prgBytes,
      startRomOff: entry,
      targetRomOffs: islandStartRomOffs
    });
    if (!rawDecoded.ok) {
      entryReachCache.set(entry, []);
      return [];
    }

    const islands = islandsByStartRomOff.get(rawDecoded.targetRomOff >>> 0) || [];
    entryReachCache.set(entry, islands);
    return islands;
  }

  function resolveFrontierFromSourceSite(rawFrontier, sourceSite) {
    const decoded = decodeInstructionAtSite({
      prgBytes: context.prgBytes,
      mapper: context.mapper,
      mapperContext: sourceSite.mapperContext,
      cpuAddr: sourceSite.cpuAddr & 0xffff
    });
    if (!decoded.ok || !isDecodedMatchingRawFrontier(decoded.instruction, rawFrontier)) return null;

    const resolved = context.mapper.resolveControlTarget(sourceSite.mapperContext, rawFrontier.targetCpuAddr & 0xffff, {
      policy: 'exactOnly',
      purpose: 'functionExcavationFrontierTarget'
    });
    if (!resolved.ok) return null;

    const targetSite = cloneSite(resolved.target);
    return {
      sourceSite: cloneSite(sourceSite),
      targetSite,
      targetRomOff: targetSite.romOff >>> 0
    };
  }

  function makeAcceptedCodeSpan(candidate) {
    const instructionRomOffs = requireArray(candidate.instructionRomOffs, 'function excavation candidate.instructionRomOffs')
      .map((item) => item >>> 0);
    if (!instructionRomOffs.length) throw new Error('function excavation candidate has no instruction ROM offsets');
    const possibleAppearances = Array.isArray(candidate.possibleAppearances)
      ? candidate.possibleAppearances.map((appearance) => cloneAppearance(appearance))
      : (candidate.entrySite ? [cloneAppearance(candidate.entrySite)] : []);
    return {
      acceptedCodeSpanId: `functionExcavation:${candidate.candidateId}`,
      source: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
      kind: candidate.kind,
      candidateId: candidate.candidateId,
      frontierId: candidate.frontierId || null,
      islandId: candidate.islandId,
      anchorId: candidate.anchorId,
      recognitionMode: candidate.recognitionMode,
      promotionMode: candidate.promotionMode || 'frontierReachableIsland',
      romStart: instructionRomOffs[0] >>> 0,
      romEnd: candidate.decodeEndRomOff >>> 0,
      entryRomOff: candidate.entryRomOff >>> 0,
      anchorRomOff: candidate.anchorRomOff >>> 0,
      terminatorRomOff: candidate.terminatorRomOff >>> 0,
      instructionRomOffs,
      possibleAppearances,
      evidence: candidate.evidence && typeof candidate.evidence === 'object' ? candidate.evidence : null
    };
  }

  function recordCandidateAndPromoteCode(candidate) {
    result.candidates.push(candidate);
    result.counters.candidates = result.candidates.length;
    const kind = String(candidate.kind);
    if (!result.counters.byKind[kind]) result.counters.byKind[kind] = makeKindCounters();
    result.counters.byKind[kind].candidates += 1;

    const acceptedCodeSpan = makeAcceptedCodeSpan(candidate);
    const addResult = typeof context.addAcceptedCodeSpan === 'function'
      ? context.addAcceptedCodeSpan(acceptedCodeSpan)
      : { added: true, span: acceptedCodeSpan };
    if (!addResult.added) {
      result.counters.duplicateSeeds += 1;
      return;
    }
    const storedSpan = addResult.span || acceptedCodeSpan;
    result.acceptedCodeSpans.push(storedSpan);
    result.counters.acceptedCodeSpans = result.acceptedCodeSpans.length;
    result.counters.possibleAppearances += acceptedCodeSpan.possibleAppearances.length;
    if (typeof context.noteNewCfgWork === 'function') {
      context.noteNewCfgWork({
        phaseId: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
        reason: 'acceptedExcavatedCode',
        count: 1
      });
    }
    result.counters.addedSeeds += 1;
    result.counters.byKind[kind].promoted += 1;
    promotedIslandIds.add(candidate.islandId);
  }

  function promoteCandidate(rawFrontier, resolvedFrontier, island) {
    const candidateKey = `${rawFrontier.frontierId}:${resolvedFrontier.targetSite.siteKey}:${island.islandId}`;
    if (promotedCandidateKeys.has(candidateKey)) return;
    promotedCandidateKeys.add(candidateKey);

    if ((resolvedFrontier.targetRomOff >>> 0) > (island.decodeStartRomOff >>> 0)) return;

    const decoded = decodeForwardToHardTerminator({
      prgBytes: context.prgBytes,
      mapper: context.mapper,
      startSite: resolvedFrontier.targetSite,
      mustReachRomOff: island.decodeStartRomOff >>> 0
    });
    if (!decoded.ok) {
      result.rejected.push({
        kind: 'candidate',
        frontierId: rawFrontier.frontierId,
        islandId: island.islandId,
        reason: decoded.reason,
        detail: decoded.detail || null
      });
      result.counters.rejected = result.rejected.length;
      return;
    }

    const last = decoded.entries[decoded.entries.length - 1].instruction;
    const candidateId = `candidate:${result.candidates.length}`;
    recordCandidateAndPromoteCode({
      candidateId,
      kind: island.kind,
      recognitionMode: island.recognitionMode,
      frontierId: rawFrontier.frontierId,
      islandId: island.islandId,
      anchorId: island.anchorId,
      entrySite: cloneSite(resolvedFrontier.targetSite),
      sourceSite: cloneSite(resolvedFrontier.sourceSite),
      entryRomOff: resolvedFrontier.targetRomOff >>> 0,
      anchorRomOff: island.decodeStartRomOff >>> 0,
      decodeEndRomOff: (last.romOff + last.size) >>> 0,
      terminatorRomOff: last.romOff >>> 0,
      instructionRomOffs: decoded.entries.map((entry) => entry.instruction.romOff >>> 0),
      evidence: island.evidence,
      promotionMode: 'frontierReachableIsland'
    });
  }

  function decodeDirectIslandAppearance(island, rawEntrySite) {
    const entrySite = cloneSite(rawEntrySite);
    const decoded = decodeForwardToHardTerminator({
      prgBytes: context.prgBytes,
      mapper: context.mapper,
      startSite: entrySite,
      mustReachRomOff: island.decodeStartRomOff >>> 0
    });
    if (!decoded.ok) {
      result.rejected.push({
        kind: 'candidate',
        frontierId: null,
        islandId: island.islandId,
        reason: decoded.reason,
        detail: decoded.detail || null,
        promotionMode: 'directRecognizedIsland'
      });
      result.counters.rejected = result.rejected.length;
      return null;
    }
    return { entrySite, decoded };
  }

  function promoteDirectIslandCandidate(island, rawEntrySites) {
    const candidateKey = `direct:${island.islandId}`;
    if (promotedCandidateKeys.has(candidateKey)) return;
    promotedCandidateKeys.add(candidateKey);

    const validAppearances = [];
    let acceptedDecode = null;
    for (const rawEntrySite of rawEntrySites) {
      const decodedAppearance = decodeDirectIslandAppearance(island, rawEntrySite);
      if (!decodedAppearance) continue;
      validAppearances.push(cloneAppearance(decodedAppearance.entrySite));
      if (!acceptedDecode) acceptedDecode = decodedAppearance.decoded;
    }
    if (!acceptedDecode || !validAppearances.length) return;

    const last = acceptedDecode.entries[acceptedDecode.entries.length - 1].instruction;
    const candidateId = `candidate:${result.candidates.length}`;
    recordCandidateAndPromoteCode({
      candidateId,
      kind: island.kind,
      recognitionMode: island.recognitionMode,
      frontierId: null,
      islandId: island.islandId,
      anchorId: island.anchorId,
      entrySite: null,
      sourceSite: null,
      entryRomOff: island.decodeStartRomOff >>> 0,
      anchorRomOff: island.decodeStartRomOff >>> 0,
      decodeEndRomOff: (last.romOff + last.size) >>> 0,
      terminatorRomOff: last.romOff >>> 0,
      instructionRomOffs: acceptedDecode.entries.map((entry) => entry.instruction.romOff >>> 0),
      possibleAppearances: validAppearances,
      evidence: island.evidence,
      promotionMode: 'directRecognizedIsland'
    });
  }

  function promoteDirectIslandCandidatesChunk() {
    const mapper = requireObject(context.mapper, 'functionExcavation mapper');
    const endIndex = Math.min(directPromotionIslandIndex + DIRECT_PROMOTION_CHUNK_ISLANDS, result.islands.length);

    for (; directPromotionIslandIndex < endIndex; directPromotionIslandIndex += 1) {
      const island = result.islands[directPromotionIslandIndex];
      const entrySites = sitesForRomOff(mapper, island.decodeStartRomOff >>> 0, 'functionExcavationDirectCandidate');
      promoteDirectIslandCandidate(island, entrySites);
    }

    if (directPromotionIslandIndex >= result.islands.length) directPromotionComplete = true;
  }

  function processRawFrontier(rawFrontier) {
    const mapper = requireObject(context.mapper, 'functionExcavation mapper');
    const sourceSites = sitesForRomOff(mapper, rawFrontier.sourceRomOff);
    if (!sourceSites.length) return;

    for (const rawSourceSite of sourceSites) {
      const sourceSite = cloneSite(rawSourceSite);
      const resolvedFrontier = resolveFrontierFromSourceSite(rawFrontier, sourceSite);
      if (!resolvedFrontier) continue;

      const islands = islandsReachedFromEntryRomOff(resolvedFrontier.targetRomOff);
      if (!islands.length) continue;

      for (const island of islands) {
        promoteCandidate(rawFrontier, resolvedFrontier, island);
      }
    }
  }

  function scanFrontiersChunk() {
    const prgBytes = context.prgBytes;
    const endRomOff = Math.min(frontierScanRomOff + scanChunkBytes, prgBytes.length);

    for (let romOff = frontierScanRomOff; romOff < endRomOff; romOff += 1) {
      result.counters.scannedRomOffsets += 1;
      result.counters.frontierScanRomOffsets += 1;
      if (!isRawDirectControlFrontierStart(prgBytes, romOff)) continue;

      const rawFrontier = makeRawFrontier(`frontier:${result.frontiers.length}`, prgBytes, romOff);
      const frontierKey = `${rawFrontier.kind}:${rawFrontier.sourceRomOff}:${rawFrontier.targetCpuAddr}`;
      if (seenFrontiers.has(frontierKey)) continue;
      seenFrontiers.add(frontierKey);

      result.frontiers.push(rawFrontier);
      result.counters.frontiers = result.frontiers.length;
      processRawFrontier(rawFrontier);
    }

    frontierScanRomOff = endRomOff;
    if (frontierScanRomOff >= prgBytes.length) frontierScanComplete = true;
  }

  function finalize() {
    if (finalized) return;
    finalized = true;
    progressStage = 'complete';
    context.functionExcavation = result;
    console.log(`[analyze] functionExcavation found ${result.counters.candidates} candidate function(s), promoted ${result.counters.addedSeeds}`);
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
      status: 'complete',
      counters: { ...result.counters, byKind: cloneKindCounters(result.counters.byKind) }
    });
  }

  return {
    name: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
    stepOne() {
      requireObject(context.mapper, 'functionExcavation mapper');

      if (!islandScanComplete) {
        progressStage = 'islandScan';
        scanIslandsChunk();
        context.functionExcavation = result;
        return {
          status: 'running',
          phase: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
          progressNow: true
        };
      }

      if (PROMOTE_ALL_CANDIDATES) {
        if (!directPromotionComplete && result.islands.length > 0) {
          progressStage = 'directPromotion';
          promoteDirectIslandCandidatesChunk();
          context.functionExcavation = result;
          return {
            status: 'running',
            phase: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
            progressNow: true
          };
        }
        directPromotionComplete = true;
        frontierScanComplete = true;
      } else if (!frontierScanComplete && result.islands.length > 0) {
        progressStage = 'frontierScan';
        scanFrontiersChunk();
        context.functionExcavation = result;
        return {
          status: 'running',
          phase: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION,
          progressNow: true
        };
      }

      frontierScanComplete = true;
      finalize();
      return { status: 'complete', progress: progressPayload() };
    },
    progress() {
      return progressPayload();
    }
  };
}
