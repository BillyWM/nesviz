function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function finiteInt(value) {
  return Number.isFinite(value) ? (value | 0) : null;
}

function finiteRatio(value) {
  return Number.isFinite(value) ? value : null;
}

function compactDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const out = {};

  const numericKeys = [
    'decodedBytesBucket',
    'decodedBytesBonus',
    'badTailPenalty',
    'repeatPatternPenalty',
    'semanticBitwiseRepeatPenalty',
    'semanticRotateRepeatPenalty',
    'semanticFlagRepeatPenalty',
    'suspiciousRepeatRunCount',
    'semanticBitwiseRepeatRunCount',
    'semanticRotateRepeatRunCount',
    'semanticFlagRepeatRunCount',
    'periodicPrefixPeriod',
    'periodicPrefixBytes',
    'periodicPrefixRatio'
  ];

  for (const key of numericKeys) {
    const value = details[key];
    if (!Number.isFinite(value)) continue;
    if (value === 0 && key !== 'decodedBytesBucket') continue;
    out[key] = value;
  }

  const booleanKeys = [
    'endsOnTerminator',
    'endsOnCap',
    'rtiInterruptRoot',
    'suspiciousBitwiseImmediateWall',
    'periodicPrefixSupport',
    'hardRejected'
  ];

  for (const key of booleanKeys) {
    if (details[key] === true) out[key] = true;
  }

  const stringKeys = ['terminatorMnemonic', 'endReason', 'lastFlowType', 'hardRejectReason'];
  for (const key of stringKeys) {
    if (typeof details[key] === 'string' && details[key]) out[key] = details[key];
  }

  return Object.keys(out).length ? out : null;
}

export function compactProbableScore(score) {
  if (!score || typeof score !== 'object') return null;
  const out = {
    totalScore: finiteNumber(score.totalScore),
    decodedBytes: finiteInt(score.decodedBytes),
    branchHitRate: finiteRatio(score.branchHitRate),
    reachableRatio: finiteRatio(score.reachableRatio),
    details: compactDetails(score.details)
  };

  if (out.totalScore === null) delete out.totalScore;
  if (out.decodedBytes === null) delete out.decodedBytes;
  if (out.branchHitRate === null) delete out.branchHitRate;
  if (out.reachableRatio === null) delete out.reachableRatio;
  if (!out.details) delete out.details;

  return Object.keys(out).length ? out : null;
}

function reasonLabel(reason) {
  switch (reason) {
    case 'directLinkToConfirmed': return 'direct link to confirmed code';
    case 'directLinkFromConfirmed': return 'direct link from confirmed code';
    case 'vsaControlToConfirmed': return 'VSA control flow to confirmed code';
    case 'vsaCandidateControlCluster': return 'VSA candidate control cluster';
    case 'romReadPointerIndirectUse': return 'ROM-read pointer used indirectly';
    case 'pointerToIndirectUse': return 'pointer used indirectly';
    case 'strongStreamReader': return 'strong stream reader';
    case 'strongInternalCfg': return 'strong internal CFG';
    case 'goalDrivenVerifiedReaderBundle': return 'goal-driven verified reader bundle';
    case 'romReadPointerBundle': return 'ROM-read pointer bundle';
    case 'dataReaderWithControlShapeBundle': return 'data reader with control-shape bundle';
    case 'vsaCandidateControlBundle': return 'VSA candidate control bundle';
    case 'unprovenCandidate': return 'unproven candidate';
    default: return typeof reason === 'string' && reason ? reason : null;
  }
}

function evidenceLabel(kind) {
  switch (kind) {
    case 'directLinkToConfirmed': return 'direct link to confirmed code';
    case 'directLinkFromConfirmed': return 'direct link from confirmed code';
    case 'vsaIndirectJumpTargetToConfirmed': return 'VSA indirect jump target to confirmed code';
    case 'vsaBankedTargetToConfirmed': return 'VSA banked target to confirmed code';
    case 'vsaCandidateControlCluster': return 'VSA candidate control cluster';
    case 'romReadPointerIndirectUse': return 'ROM-read pointer used indirectly';
    case 'pointerToIndirectUse': return 'pointer used indirectly';
    case 'strongStreamReader': return 'strong stream reader';
    case 'strongInternalCfg': return 'strong internal CFG';
    case 'internalCfgConnection': return 'internal CFG connection';
    case 'internalCfgCycle': return 'internal CFG cycle';
    case 'goalDrivenSeedContext': return 'goal-driven seed context';
    case 'tightRomRead': return 'tight ROM read';
    case 'romReadToPointer': return 'ROM read to pointer';
    case 'romReadMeaningfulUse': return 'ROM read has meaningful use';
    case 'vsaIndirectJumpTargetToCandidate': return 'VSA indirect jump target to candidate';
    case 'vsaBankedTargetToCandidate': return 'VSA banked target to candidate';
    case 'realTerminatorContext': return 'real terminator context';
    case 'dispatchSeedContext': return 'dispatch seed context';
    default: return typeof kind === 'string' && kind ? kind : null;
  }
}

function uniqueByJson(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (!value || typeof value !== 'object') continue;
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function compactEvidenceDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  const scalarKeys = [
    'blockId',
    'kind',
    'edgeKind',
    'from',
    'to',
    'siteKey',
    'basis',
    'use',
    'observationId',
    'useObservationId',
    'pointerObservationId',
    'indirectReadObservationId',
    'footprintId',
    'evidenceQuality'
  ];
  for (const key of scalarKeys) {
    if (typeof detail[key] === 'string' && detail[key]) out[key] = detail[key];
  }
  for (const key of ['zpAddr', 'ptrZp']) {
    if (Number.isFinite(detail[key])) out[key] = detail[key] & 0xff;
  }
  for (const key of ['targetRawBlockIds']) {
    if (Array.isArray(detail[key]) && detail[key].length) {
      out[key] = detail[key].filter((value) => typeof value === 'string' && value).slice(0, 16);
    }
  }
  return Object.keys(out).length ? out : null;
}

function compactEvidenceDetails(details) {
  if (!Array.isArray(details) || !details.length) return [];
  return uniqueByJson(details.map(compactEvidenceDetail).filter(Boolean)).slice(0, 24);
}

function compactCandidateSeedReason(reason) {
  if (!reason || reason.kind !== 'candidate_seed') return null;
  const score = compactProbableScore(reason.scoreSummary || reason.score || null);
  const out = {
    kind: 'candidate_seed',
    source: typeof reason.source === 'string' && reason.source ? reason.source : 'unknown',
    romStart: finiteInt(reason.romStart),
    romEnd: finiteInt(reason.romEnd),
    decodedBytes: finiteInt(reason.decodedBytes),
    terminatorMnemonic: typeof reason.terminatorMnemonic === 'string' && reason.terminatorMnemonic ? reason.terminatorMnemonic : null,
    endsOnTerminator: reason.endsOnTerminator === true,
    rangeStart: finiteInt(reason.rangeStart),
    rangeEnd: finiteInt(reason.rangeEnd),
    scoreSummary: score
  };

  for (const key of Object.keys(out)) {
    if (out[key] === null || out[key] === undefined || out[key] === false) delete out[key];
  }
  return out;
}

function collectCandidateSeedReasons(block) {
  const reasons = [];
  for (const reason of block?.leaderReasons || []) reasons.push(reason);
  for (const reason of block?.candidate?.leaderReasons || []) reasons.push(reason);
  return uniqueByJson(reasons.map(compactCandidateSeedReason).filter(Boolean));
}

function firstCpuStart(block) {
  const inst = Array.isArray(block?.instances) ? block.instances[0] : null;
  if (typeof inst?.cpuStart === 'number') return inst.cpuStart & 0xffff;
  const line = Array.isArray(block?.lines) ? block.lines[0] : null;
  return typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
}

function blockScoreSummary(block) {
  const score = compactProbableScore(block?.probable || null);
  if (score) return score;
  const seedReasons = collectCandidateSeedReasons(block);
  for (const reason of seedReasons) {
    if (reason.scoreSummary) return reason.scoreSummary;
  }
  return null;
}

export function buildProbablePromotionDebug(block, decision = null) {
  if (!block || typeof block !== 'object') return null;
  const acceptedReason = decision?.reason || block?.candidatePromotion?.reason || null;
  const evidenceKinds = Array.isArray(decision?.evidenceKinds)
    ? decision.evidenceKinds.filter((kind) => typeof kind === 'string' && kind)
    : (Array.isArray(block?.candidatePromotion?.evidenceKinds) ? block.candidatePromotion.evidenceKinds.filter((kind) => typeof kind === 'string' && kind) : []);

  const entry = {
    rawBlockId: typeof block.id === 'string' ? block.id : null,
    romStart: finiteInt(block.romStart),
    romEnd: finiteInt(block.romEnd),
    cpuStart: firstCpuStart(block),
    acceptedReason,
    acceptedReasonLabel: reasonLabel(acceptedReason),
    evidenceKinds,
    evidenceLabels: evidenceKinds.map(evidenceLabel).filter(Boolean),
    evidenceDetails: compactEvidenceDetails(decision?.details || []),
    seedReasons: collectCandidateSeedReasons(block),
    scoreSummary: blockScoreSummary(block)
  };

  for (const key of Object.keys(entry)) {
    if (entry[key] === null || entry[key] === undefined) delete entry[key];
    if (Array.isArray(entry[key]) && entry[key].length === 0) delete entry[key];
  }

  return { entries: [entry] };
}
