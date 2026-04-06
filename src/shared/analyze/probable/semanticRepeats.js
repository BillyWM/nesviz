function bytesKeyForInstruction(ins) {
  if (ins?.bytesKey && typeof ins.bytesKey === 'string') return ins.bytesKey;
  if (!Array.isArray(ins?.bytes)) return '';
  return ins.bytes.map((b) => ((b ?? 0) & 0xff).toString(16).padStart(2, '0')).join(' ');
}

function countBytesInBytesKey(bytesKey) {
  if (!bytesKey || typeof bytesKey !== 'string') return 0;
  return bytesKey.split(' ').filter(Boolean).length;
}

function isAccumulatorRotateMode(mode) {
  return mode === 'acc' || mode === 'imp';
}

function flattenInstructionBytes(instructions) {
  const out = [];
  for (const ins of instructions || []) {
    if (!Array.isArray(ins?.bytes) || !ins.bytes.length) continue;
    for (const b of ins.bytes) out.push(b & 0xff);
  }
  return out;
}

function computePrefixPeriodStats(bytes, maxPeriod = 3) {
  const src = Array.isArray(bytes) ? bytes : [];
  let bestPeriod = null;
  let bestBytes = 0;
  for (let period = 1; period <= maxPeriod; period++) {
    if (src.length < period * 2) continue;
    let covered = period;
    while (covered < src.length && src[covered] === src[covered % period]) covered++;
    if (covered >= period * 2 && covered > bestBytes) {
      bestBytes = covered;
      bestPeriod = period;
    }
  }
  return {
    period: bestPeriod,
    bytes: bestBytes,
    ratio: src.length ? (bestBytes / src.length) : 0
  };
}

export function buildRepeatStats(instructions) {
  const repeatRuns = [];
  const stats = {
    repeatRuns,
    maxExactCmpRun: 0,
    maxExactCpxRun: 0,
    maxExactCpyRun: 0,
    maxExactLoadImmRun: 0,
    maxExactLoadOtherRun: 0,
    maxExactImmBitwiseRun: 0
  };
  const normalized = Array.isArray(instructions) ? instructions : [];
  if (!normalized.length) return stats;

  let prev = { ...normalized[0], bytesKey: bytesKeyForInstruction(normalized[0]) };
  let runLength = 1;
  function commitRun() {
    if (!prev || runLength < 2) return;
    const run = { mnemonic: prev.mnemonic, mode: prev.mode, bytesKey: prev.bytesKey, runLength };
    repeatRuns.push(run);
    if (prev.mnemonic === 'CMP') stats.maxExactCmpRun = Math.max(stats.maxExactCmpRun, runLength);
    if (prev.mnemonic === 'CPX') stats.maxExactCpxRun = Math.max(stats.maxExactCpxRun, runLength);
    if (prev.mnemonic === 'CPY') stats.maxExactCpyRun = Math.max(stats.maxExactCpyRun, runLength);
    if ((prev.mnemonic === 'LDA' || prev.mnemonic === 'LDX' || prev.mnemonic === 'LDY') && prev.mode === 'imm') {
      stats.maxExactLoadImmRun = Math.max(stats.maxExactLoadImmRun, runLength);
    } else if (prev.mnemonic === 'LDA' || prev.mnemonic === 'LDX' || prev.mnemonic === 'LDY') {
      stats.maxExactLoadOtherRun = Math.max(stats.maxExactLoadOtherRun, runLength);
    }
    if (prev.mode === 'imm' && (prev.mnemonic === 'AND' || prev.mnemonic === 'ORA' || prev.mnemonic === 'EOR')) {
      stats.maxExactImmBitwiseRun = Math.max(stats.maxExactImmBitwiseRun, runLength);
    }
  }

  for (let i = 1; i < normalized.length; i++) {
    const ins = normalized[i];
    const insBytesKey = bytesKeyForInstruction(ins);
    if (insBytesKey && prev.bytesKey && insBytesKey === prev.bytesKey) {
      runLength++;
    } else {
      commitRun();
      prev = { ...ins, bytesKey: insBytesKey };
      runLength = 1;
    }
  }
  commitRun();
  return stats;
}

export function evaluateProbableSemanticRepeats({ instructions, decodedBytes, repeatStats = null, config }) {
  const heur = config?.heuristics || {};
  const w = config?.weights || {};
  const normalizedInstructions = Array.isArray(instructions) ? instructions : [];
  const normalizedRepeatStats = repeatStats || buildRepeatStats(normalizedInstructions);
  const totalDecodedBytes = Math.max(0, decodedBytes | 0);

  const details = {
    hardRejected: false,
    hardRejectReason: null,
    maxExactAndRun: 0,
    maxExactOraRun: 0,
    maxExactEorRun: 0,
    maxExactRolRun: 0,
    maxExactRorRun: 0,
    maxExactClcRun: 0,
    maxExactSecRun: 0,
    maxExactCldRun: 0,
    maxExactSedRun: 0,
    maxExactClvRun: 0,
    maxExactCliRun: 0,
    maxExactSeiRun: 0,
    suspiciousRepeatRunCount: 0,
    repeatPatternPenalty: 0,
    semanticBitwiseRepeatRunCount: 0,
    semanticBitwiseRepeatPenalty: 0,
    semanticRotateRepeatRunCount: 0,
    semanticRotateRepeatPenalty: 0,
    semanticFlagRepeatRunCount: 0,
    semanticFlagRepeatPenalty: 0,
    periodicPrefixPeriod: null,
    periodicPrefixBytes: 0,
    periodicPrefixRatio: 0,
    periodicPrefixSupport: false
  };

  const prefixPeriod = computePrefixPeriodStats(flattenInstructionBytes(normalizedInstructions), heur.repeatedPrefixPeriodMax ?? 3);
  details.periodicPrefixPeriod = prefixPeriod.period;
  details.periodicPrefixBytes = prefixPeriod.bytes;
  details.periodicPrefixRatio = prefixPeriod.ratio;
  details.periodicPrefixSupport = !!(
    prefixPeriod.period != null &&
    prefixPeriod.bytes >= (heur.repeatedPrefixMinBytes ?? 0) &&
    prefixPeriod.ratio >= (heur.repeatedPrefixMinRatio ?? 0)
  );

  let suspiciousRepeatRunCount = 0;
  let repeatPatternPenalty = 0;
  let semanticBitwiseRepeatRunCount = 0;
  let semanticBitwiseRepeatPenalty = 0;
  let semanticRotateRepeatRunCount = 0;
  let semanticRotateRepeatPenalty = 0;
  let semanticFlagRepeatRunCount = 0;
  let semanticFlagRepeatPenalty = 0;

  for (const run of normalizedRepeatStats.repeatRuns || []) {
    const m = run.mnemonic;
    const mode = run.mode;
    const n = run.runLength | 0;
    const unitBytes = countBytesInBytesKey(run.bytesKey);
    const runBytes = unitBytes * n;
    const runRatio = totalDecodedBytes > 0 ? (runBytes / totalDecodedBytes) : 0;
    const periodMatchesRun = details.periodicPrefixSupport && prefixPeriod.period === unitBytes;
    const repeatedSequenceSupport = periodMatchesRun || runRatio >= (heur.semanticBitwiseRepeatRunMinRatio ?? 0);

    if (m === 'AND' || m === 'ORA' || m === 'EOR') {
      if (m === 'AND') details.maxExactAndRun = Math.max(details.maxExactAndRun, n);
      if (m === 'ORA') details.maxExactOraRun = Math.max(details.maxExactOraRun, n);
      if (m === 'EOR') details.maxExactEorRun = Math.max(details.maxExactEorRun, n);

      const minPenaltyRun = (m === 'EOR') ? heur.semanticExactEorPenaltyRun : heur.semanticExactBitwisePenaltyRun;
      const minStrongPenaltyRun = (m === 'EOR') ? heur.semanticExactEorPenaltyRunStrong : heur.semanticExactBitwisePenaltyRunStrong;
      const minRejectRun = (m === 'EOR') ? heur.semanticExactEorRejectRun : heur.semanticExactBitwiseRejectRun;

      if (n >= minPenaltyRun) {
        suspiciousRepeatRunCount++;
        semanticBitwiseRepeatRunCount++;
        const basePenalty = (n >= minStrongPenaltyRun) ? w.semanticExactBitwiseRepeatPenaltyStrong : w.semanticExactBitwiseRepeatPenalty;
        repeatPatternPenalty += basePenalty;
        semanticBitwiseRepeatPenalty += basePenalty;

        if (repeatedSequenceSupport) {
          repeatPatternPenalty += w.semanticExactBitwisePeriodicSupportPenalty;
          semanticBitwiseRepeatPenalty += w.semanticExactBitwisePeriodicSupportPenalty;
        }
      }

      if (!details.hardRejected && n >= minRejectRun && repeatedSequenceSupport) {
        details.hardRejected = true;
        details.hardRejectReason = `semantic_repeat_${m.toLowerCase()}`;
      }
    } else if (m === 'ROL' || m === 'ROR') {
      if (m === 'ROL') details.maxExactRolRun = Math.max(details.maxExactRolRun, n);
      if (m === 'ROR') details.maxExactRorRun = Math.max(details.maxExactRorRun, n);

      if (!details.hardRejected && n >= (heur.semanticRotateRejectRun ?? 10)) {
        details.hardRejected = true;
        details.hardRejectReason = `semantic_repeat_${m.toLowerCase()}`;
      }

      const rotateRepeatedSequenceSupport = periodMatchesRun || runRatio >= (heur.semanticRotateRepeatRunMinRatio ?? 0);
      const unitLooksDataLike = unitBytes >= 2 || isAccumulatorRotateMode(mode);
      if (n >= (heur.semanticRotatePenaltyRun ?? 3) && rotateRepeatedSequenceSupport && unitLooksDataLike) {
        suspiciousRepeatRunCount++;
        semanticRotateRepeatRunCount++;
        const basePenalty = (n >= (heur.semanticRotatePenaltyRunStrong ?? 5)) ? w.semanticRotateRepeatPenaltyStrong : w.semanticRotateRepeatPenalty;
        repeatPatternPenalty += basePenalty;
        semanticRotateRepeatPenalty += basePenalty;

        if (periodMatchesRun) {
          repeatPatternPenalty += w.semanticRotatePeriodicSupportPenalty;
          semanticRotateRepeatPenalty += w.semanticRotatePeriodicSupportPenalty;
        }
      }
    } else if (m === 'CLC' || m === 'SEC' || m === 'CLD' || m === 'SED' || m === 'CLV' || m === 'CLI' || m === 'SEI') {
      if (m === 'CLC') details.maxExactClcRun = Math.max(details.maxExactClcRun, n);
      if (m === 'SEC') details.maxExactSecRun = Math.max(details.maxExactSecRun, n);
      if (m === 'CLD') details.maxExactCldRun = Math.max(details.maxExactCldRun, n);
      if (m === 'SED') details.maxExactSedRun = Math.max(details.maxExactSedRun, n);
      if (m === 'CLV') details.maxExactClvRun = Math.max(details.maxExactClvRun, n);
      if (m === 'CLI') details.maxExactCliRun = Math.max(details.maxExactCliRun, n);
      if (m === 'SEI') details.maxExactSeiRun = Math.max(details.maxExactSeiRun, n);

      const isInterruptFlagWrite = m === 'CLI' || m === 'SEI';
      const penaltyRun = isInterruptFlagWrite
        ? (heur.semanticInterruptFlagPenaltyRun ?? 2)
        : (heur.semanticFlagWritePenaltyRun ?? 2);
      const strongPenaltyRun = isInterruptFlagWrite
        ? (heur.semanticInterruptFlagPenaltyRunStrong ?? 3)
        : (heur.semanticFlagWritePenaltyRunStrong ?? 3);
      const rejectRun = heur.semanticFlagWriteRejectRun ?? 3;

      if (n >= penaltyRun) {
        suspiciousRepeatRunCount++;
        semanticFlagRepeatRunCount++;
        const basePenalty = isInterruptFlagWrite
          ? ((n >= strongPenaltyRun) ? w.semanticInterruptFlagRepeatPenaltyStrong : w.semanticInterruptFlagRepeatPenalty)
          : ((n >= strongPenaltyRun) ? w.semanticFlagWriteRepeatPenaltyStrong : w.semanticFlagWriteRepeatPenalty);
        repeatPatternPenalty += basePenalty;
        semanticFlagRepeatPenalty += basePenalty;
      }

      if (!details.hardRejected && !isInterruptFlagWrite && n >= rejectRun) {
        details.hardRejected = true;
        details.hardRejectReason = `semantic_repeat_${m.toLowerCase()}`;
      }
    }
  }

  if (suspiciousRepeatRunCount >= (heur.suspiciousRepeatRunEscalationCount ?? 0)) {
    repeatPatternPenalty += w.multipleSuspiciousRepeatRunsPenalty;
  }

  details.suspiciousRepeatRunCount = suspiciousRepeatRunCount;
  details.repeatPatternPenalty = repeatPatternPenalty;
  details.semanticBitwiseRepeatRunCount = semanticBitwiseRepeatRunCount;
  details.semanticBitwiseRepeatPenalty = semanticBitwiseRepeatPenalty;
  details.semanticRotateRepeatRunCount = semanticRotateRepeatRunCount;
  details.semanticRotateRepeatPenalty = semanticRotateRepeatPenalty;
  details.semanticFlagRepeatRunCount = semanticFlagRepeatRunCount;
  details.semanticFlagRepeatPenalty = semanticFlagRepeatPenalty;

  return details;
}
