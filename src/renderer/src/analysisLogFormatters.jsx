function numberOrZero(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function stageLabel(stage) {
  if (stage === 'islandScan') return 'Island scan';
  if (stage === 'frontierScan') return 'Frontier scan';
  if (stage === 'complete') return 'Complete';
  return '';
}

function aiModeLabel(mode) {
  if (mode === 'widening') return 'Widening';
  if (mode === 'narrowing') return 'Narrowing';
  return mode ? String(mode) : 'Working';
}

function aiNarrowingStageLabel(stage) {
  if (stage === 'prepareRound' || stage === 'prepareNarrowingRound') return 'Preparing round';
  if (stage === 'computeCandidates' || stage === 'computeNarrowingCandidates') return 'Computing candidates';
  if (stage === 'applyCandidates' || stage === 'applyNarrowingCandidates') return 'Applying candidates';
  if (stage === 'finalizeOutStates' || stage === 'finalizeNarrowedOutStates') return 'Finalizing output states';
  if (stage === 'done') return 'Done';
  if (stage === 'notStarted') return 'Not started';
  return stage ? String(stage) : '';
}

function formatInteger(value) {
  return numberOrZero(value).toLocaleString();
}

function formatAttempts(successes, attempts) {
  return `${formatInteger(successes)} / ${formatInteger(attempts)} attempts`;
}

function formatEdgeKindCounts(counts) {
  if (!counts || typeof counts !== 'object') return 'none';
  const parts = [
    ['fall', counts.fallthrough],
    ['bt', counts.branchTaken],
    ['bf', counts.branchNotTaken],
    ['jmp', counts.jump],
    ['call', counts.call],
    ['ret', counts.return],
    ['rts', counts.rtsTrick],
    ['other', counts.other]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatSummaryReturnRejectReasons(reasons) {
  if (!reasons || typeof reasons !== 'object') return 'none';
  const parts = [
    ['no summary', reasons.noSummary],
    ['no effects', reasons.noEffects],
    ['no normal', reasons.noNormalReturn],
    ['stack', reasons.stackUnsafe],
    ['unknown return', reasons.unknownReturn],
    ['indirect', reasons.indirectControl],
    ['unknown call', reasons.unknownCall],
    ['not always', reasons.notAlwaysNormal],
    ['status', reasons.unsummarizedStatus],
    ['other', reasons.other]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatSummaryReturnStackRejectReasons(reasons) {
  if (!reasons || typeof reasons !== 'object') return 'none';
  const parts = [
    ['write range', reasons.writeRange],
    ['read caller', reasons.readCaller],
    ['write caller', reasons.writeCaller],
    ['unbalanced', reasons.unbalancedReturn],
    ['unknown depth', reasons.unknownDepth],
    ['TSX', reasons.tsx],
    ['TXS', reasons.txs],
    ['transitive', reasons.transitiveCallee],
    ['normal call/return', reasons.normalCallReturn],
    ['other', reasons.other]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatSummaryReturnNoNormalRejectReasons(reasons) {
  if (!reasons || typeof reasons !== 'object') return 'none';
  const parts = [
    ['no local RTS', reasons.noLocalRts],
    ['tail jump', reasons.tailJump],
    ['tail jump to return', reasons.tailJumpToNormalReturn],
    ['tail jump missing', reasons.tailJumpMissingSummary],
    ['indirect', reasons.indirectControl],
    ['unknown call', reasons.unknownCall],
    ['unknown return', reasons.unknownReturn],
    ['local no-return', reasons.localMayNotReturn],
    ['other', reasons.other]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatSummaryReturnNoLocalRtsDetails(details) {
  if (!details || typeof details !== 'object') return 'none';
  const parts = [
    ['stopped at entry', details.stoppedAtEntry],
    ['stopped entry with reachable RTS', details.stoppedEntryWithReachableRts],
    ['stopped entry with summary normal', details.stoppedEntryWithSummaryNormal],
    ['exhausted no RTS', details.exhaustedNoRts]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatSummaryReturnNotAlwaysRejectReasons(reasons) {
  if (!reasons || typeof reasons !== 'object') return 'none';
  const parts = [
    ['local no-return', reasons.localMayNotReturn],
    ['tail jump', reasons.tailJump],
    ['tail jump to return', reasons.tailJumpToNormalReturn],
    ['transitive', reasons.transitiveCallee],
    ['indirect', reasons.indirectControl],
    ['unknown call', reasons.unknownCall],
    ['unknown return', reasons.unknownReturn],
    ['other', reasons.other]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatDirectTransitiveReasons(reasons, localKey = 'local', localLabel = localKey) {
  if (!reasons || typeof reasons !== 'object') return 'none';
  const parts = [
    [localLabel, reasons[localKey]],
    ['transitive', reasons.transitive],
    ['other', reasons.other]
  ]
    .map(([label, value]) => [label, numberOrZero(value)])
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatInteger(value)}`);
  return parts.length ? parts.join(', ') : 'none';
}

function formatHex(value, width) {
  if (!Number.isFinite(value)) return '';
  return `$${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function returnEdgeRejectReasonLabel(reason) {
  if (reason === 'stackUnsafe') return 'stack';
  if (reason === 'noNormalReturn') return 'no normal';
  if (reason === 'unknownReturn') return 'unknown return';
  if (reason === 'indirectControl') return 'indirect';
  if (reason === 'unknownCall') return 'unknown call';
  if (reason === 'notAlwaysNormal') return 'not always';
  if (reason === 'unsummarizedStatus') return 'status';
  if (reason === 'noSummary') return 'no summary';
  if (reason === 'noEffects') return 'no effects';
  return reason ? String(reason) : 'other';
}

function formatReturnEdgeRejectSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return 'none';
  return sources
    .map((source) => {
      const count = formatInteger(source?.count);
      const reason = returnEdgeRejectReasonLabel(source?.reason);
      const detail = source?.detail ? String(source.detail) : 'other';
      const location = Number.isFinite(source?.cpuStart)
        ? formatHex(source.cpuStart, 4)
        : (Number.isFinite(source?.entryRomOff)
          ? `rom ${formatHex(source.entryRomOff, 6)}`
          : String(source?.entryBlockInstanceId || 'unknown'));
      return `${reason}/${detail} ${location}: ${count}`;
    })
    .join('; ');
}

function ProgressBar({ value, max, label }) {
  const safeValue = numberOrZero(value);
  const safeMax = numberOrZero(max);
  const ratio = safeMax > 0 ? Math.min(1, safeValue / safeMax) : 0;

  return (
    <div className="nv-analysis-log-progress-row">
      <div className="nv-analysis-log-progress" role="progressbar" aria-valuemin="0" aria-valuemax={safeMax} aria-valuenow={safeValue}>
        <div className="nv-analysis-log-progress-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="nv-analysis-log-progress-text">{label}</div>
    </div>
  );
}

function StatGrid({ children }) {
  return <div className="nv-analysis-log-stat-grid">{children}</div>;
}

function Stat({ label, value }) {
  return (
    <span className="nv-analysis-log-stat">
      <span className="nv-analysis-log-stat-label">{label}:</span>{' '}
      <span className="nv-analysis-log-stat-value">{value}</span>
    </span>
  );
}

function functionExcavationKindEntries(byKind) {
  if (!byKind || typeof byKind !== 'object') return [];
  return Object.entries(byKind)
    .map(([kind, counters]) => ({
      kind,
      candidates: numberOrZero(counters?.candidates),
      promoted: numberOrZero(counters?.promoted)
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

function FunctionExcavationDetails({ details }) {
  const scannedBytes = numberOrZero(details?.scannedBytes);
  const totalBytes = numberOrZero(details?.totalBytes);
  const candidates = numberOrZero(details?.candidates);
  const promoted = numberOrZero(details?.promoted);
  const kindEntries = functionExcavationKindEntries(details?.byKind);
  const label = stageLabel(details?.stage);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-function-excavation-detail">
      <ProgressBar
        value={scannedBytes}
        max={totalBytes}
        label={`${label ? `${label}: ` : ''}${formatInteger(scannedBytes)} / ${formatInteger(totalBytes)} bytes`}
      />
      <div className="nv-analysis-log-stat-row">
        <span>Function excavation: {formatInteger(candidates)} candidates, {formatInteger(promoted)} promoted</span>
      </div>
      {kindEntries.length > 0 ? (
        <div>
          {kindEntries.map((entry) => (
            <div className="nv-analysis-log-stat-row" key={entry.kind}>
              <span>{entry.kind}: {formatInteger(entry.candidates)} candidates, {formatInteger(entry.promoted)} promoted</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FunctionSummarizationDetails({ details }) {
  return (
    <div className="nv-analysis-log-detail nv-analysis-log-function-summarization-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Function summaries: {formatInteger(details?.functionCount)} functions, {formatInteger(details?.cacheHits)} cached, {formatInteger(details?.cacheMisses)} computed</span>
      </div>
      <StatGrid>
        <Stat label="Mapper unchanged" value={formatInteger(details?.mapperUnchangedCount)} />
        <Stat label="RAM unchanged" value={formatInteger(details?.ramUnchangedCount)} />
        <Stat label="Stack safe" value={formatInteger(details?.stackReturnSafeCount)} />
        <Stat label="Registers preserved" value={formatInteger(details?.doesntClobberRegistersCount)} />
        <Stat label="Flags preserved" value={formatInteger(details?.doesntClobberFlagsCount)} />
        <Stat label="Unknown control" value={formatInteger(details?.unknownControlCount)} />
        <Stat label="Unknown calls" value={formatInteger(details?.unknownCallTargetCount)} />
      </StatGrid>
      <div className="nv-analysis-log-stat-row">
        <span>Tail returns folded: {formatInteger(details?.tailJumpReturnComposedFunctionCount)} funcs, {formatInteger(details?.tailJumpReturnComposedTargetCount)} targets</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Boundary entries folded: {formatInteger(details?.boundaryEntryComposedFunctionCount)} funcs, {formatInteger(details?.boundaryEntryComposedTargetCount)} targets, {formatInteger(details?.boundaryEntryMissingSummaryCount)} missing</span>
      </div>
    </div>
  );
}

function StrictCfgDetails({ details }) {
  const blockCount = numberOrZero(details?.physicalBlockCount);
  const blockInstanceCount = numberOrZero(details?.blockInstanceCount);
  const decodedInstructions = numberOrZero(details?.decodedInstructions);
  const edgeCount = numberOrZero(details?.edgeCount);
  const frontierCount = numberOrZero(details?.frontierCount);
  const seedCount = numberOrZero(details?.seedCount);
  const visitedSites = numberOrZero(details?.visitedSites);
  const queuedSites = numberOrZero(details?.queuedSites);
  const blockSplits = numberOrZero(details?.blockSplits);
  const indirectFrontiers = numberOrZero(details?.indirectJumpFrontierCount);
  const mapperFrontiers = numberOrZero(details?.possibleMapperWriteFrontierCount);
  const unmappedFrontiers = numberOrZero(details?.unmappedTargetFrontierCount);
  const ambiguousFrontiers = numberOrZero(details?.ambiguousDirectTargetFrontierCount);
  const decodeFrontiers = numberOrZero(details?.decodeFailedFrontierCount);
  const unsupportedFrontiers = numberOrZero(details?.unsupportedControlFlowFrontierCount);
  const contextsSeen = numberOrZero(details?.contextsSeen);
  const mapperWritesObserved = numberOrZero(details?.mapperWritesObserved);
  const mapperWritesResolved = numberOrZero(details?.mapperWritesResolved);
  const mapperWritesUnresolved = numberOrZero(details?.mapperWritesUnresolved);
  const showMapper = contextsSeen > 1 || mapperWritesObserved > 0 || mapperFrontiers > 0;

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-strict-cfg-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Strict CFG: {formatInteger(blockCount)} blocks, {formatInteger(decodedInstructions)} instructions, {formatInteger(edgeCount)} edges</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Sites: {formatInteger(seedCount)} seeds, {formatInteger(visitedSites)} visited, {formatInteger(queuedSites)} queued, {formatInteger(blockSplits)} splits</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Frontiers: {formatInteger(frontierCount)} — indirect {formatInteger(indirectFrontiers)}, mapper {formatInteger(mapperFrontiers)}, unmapped {formatInteger(unmappedFrontiers)}, ambiguous {formatInteger(ambiguousFrontiers)}, decode {formatInteger(decodeFrontiers)}, unsupported {formatInteger(unsupportedFrontiers)}</span>
      </div>
      {showMapper ? (
        <div className="nv-analysis-log-stat-row">
          <span>Mapper: {formatInteger(contextsSeen)} contexts, {formatInteger(mapperWritesObserved)} writes, {formatInteger(mapperWritesResolved)} resolved, {formatInteger(mapperWritesUnresolved)} unresolved</span>
        </div>
      ) : null}
      <StatGrid>
        <Stat label="Block instances" value={formatInteger(blockInstanceCount)} />
        <Stat label="Fallthrough edges" value={formatInteger(details?.fallthroughEdgeCount)} />
        <Stat label="Branch edges" value={formatInteger(details?.branchEdgeCount)} />
        <Stat label="Jump edges" value={formatInteger(details?.jumpEdgeCount)} />
        <Stat label="Call edges" value={formatInteger(details?.callEdgeCount)} />
        <Stat label="Physical continuation" value={formatInteger(details?.physicalContinuationEdgeCount)} />
        <Stat label="Forced branches" value={formatInteger(details?.forcedBranches)} />
        <Stat label="Pruned edges" value={formatInteger(details?.prunedBranchEdges)} />
        <Stat label="RTS stops" value={formatInteger(details?.rtsStops)} />
        <Stat label="RTI stops" value={formatInteger(details?.rtiStops)} />
        <Stat label="BRK stops" value={formatInteger(details?.brkStops)} />
      </StatGrid>
    </div>
  );
}

function AbstractInterpretationReuseDetails({ details }) {
  const reusableSccs = numberOrZero(details?.reusableSccCount);
  const dirtySccs = numberOrZero(details?.dirtySccCount);
  const cachedBlockStates = numberOrZero(details?.cachedBlockStates);
  const recomputedBlockStates = numberOrZero(details?.recomputedBlockStates);

  return (
    <div className="nv-analysis-log-detail-section">
      <div className="nv-analysis-log-stat-row">
        <span>SCC reuse: {formatInteger(reusableSccs)} reusable, {formatInteger(dirtySccs)} dirty</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>State reuse: {formatInteger(cachedBlockStates)} cached, {formatInteger(recomputedBlockStates)} recomputed</span>
      </div>
    </div>
  );
}

function AbstractInterpretationSccDetails({ details }) {
  const currentIndex = numberOrZero(details?.currentSccIndex);
  const total = numberOrZero(details?.sccCount);
  const currentSize = numberOrZero(details?.currentSccBlockCount);
  const largestSize = numberOrZero(details?.largestSccBlockCount);
  const largestCyclicSize = numberOrZero(details?.largestCyclicSccBlockCount);
  const returnEdges = numberOrZero(details?.normalReturnEdgeCount);
  const excludedReturnEdges = numberOrZero(details?.schedulingExcludedReturnEdgeCount);
  const returnEdgeSummaryCount = numberOrZero(details?.returnEdgeSummaryCount);
  const summaryUsableReturnEdges = numberOrZero(details?.summaryUsableReturnEdgeCount ?? details?.summaryUsableReturnEdges);
  const summaryRejectedReturnEdges = numberOrZero(details?.summaryRejectedReturnEdgeCount ?? details?.summaryRejectedReturnEdges);
  const missingCallEdgeReturnEdges = numberOrZero(details?.missingCallEdgeReturnEdgeCount ?? details?.missingCallEdgeReturnEdges);
  const missingCallTargetReturnEdges = numberOrZero(details?.missingCallTargetReturnEdgeCount ?? details?.missingCallTargetReturnEdges);
  const returnEdgeSummaryRejectReasons = details?.returnEdgeSummaryRejectReasons;
  const returnEdgeSummaryStackRejectReasons = details?.returnEdgeSummaryStackRejectReasons;
  const returnEdgeSummaryNoNormalRejectReasons = details?.returnEdgeSummaryNoNormalRejectReasons;
  const returnEdgeSummaryNotAlwaysRejectReasons = details?.returnEdgeSummaryNotAlwaysRejectReasons;
  const returnEdgeSummaryIndirectRejectReasons = details?.returnEdgeSummaryIndirectRejectReasons;
  const returnEdgeSummaryUnknownCallRejectReasons = details?.returnEdgeSummaryUnknownCallRejectReasons;
  const returnEdgeSummaryUnknownReturnRejectReasons = details?.returnEdgeSummaryUnknownReturnRejectReasons;
  const returnEdgeSummaryRejectedDistinctCalleeCount = numberOrZero(details?.returnEdgeSummaryRejectedDistinctCalleeCount);
  const returnEdgeSummaryTopRejectSources = details?.returnEdgeSummaryTopRejectSources;
  const summarizedCallReturns = numberOrZero(details?.summarizedCallReturnCount ?? details?.summarizedCallReturns);
  const unsummarizedCallReturns = numberOrZero(details?.unsummarizedCallReturnCount ?? details?.unsummarizedCallReturns);
  const deferredJsrFallthroughs = numberOrZero(details?.deferredJsrFallthroughCount ?? details?.deferredJsrFallthroughs);
  const rejectedSummaryNoRtsFallback = numberOrZero(details?.rejectedSummaryNoRtsFallbackCount ?? details?.rejectedSummaryNoRtsFallback);
  const summaryReturnRejectReasons = details?.summaryReturnRejectReasons;
  const summaryReturnStackRejectReasons = details?.summaryReturnStackRejectReasons;
  const summaryReturnNoNormalRejectReasons = details?.summaryReturnNoNormalRejectReasons;
  const summaryReturnNoLocalRtsDetails = details?.summaryReturnNoLocalRtsDetails;
  const summaryReturnNotAlwaysRejectReasons = details?.summaryReturnNotAlwaysRejectReasons;
  const returnForward = numberOrZero(details?.returnEdgesForwardInSchedule);
  const returnBackward = numberOrZero(details?.returnEdgesBackwardInSchedule);
  const returnSameScc = numberOrZero(details?.returnEdgesSameSchedulingScc);
  const returnMissingScc = numberOrZero(details?.returnEdgesMissingSchedulingScc);
  const returnBoundaryPropagations = numberOrZero(details?.returnBoundaryPropagations);
  const returnBoundaryForward = numberOrZero(details?.returnBoundaryPropagationsForward);
  const returnBoundaryBackward = numberOrZero(details?.returnBoundaryPropagationsBackward);
  const returnBoundaryMissing = numberOrZero(details?.returnBoundaryPropagationsMissingScc);
  const returnBoundaryStateChanges = numberOrZero(details?.returnBoundaryStateChanges);
  const returnBoundaryContextChanges = numberOrZero(details?.returnBoundaryContextChanges);
  const returnBoundaryBackwardStateChanges = numberOrZero(details?.returnBoundaryBackwardStateChanges);
  const returnBoundaryBackwardContextChanges = numberOrZero(details?.returnBoundaryBackwardContextChanges);
  const returnBoundarySccRequeues = numberOrZero(details?.returnBoundarySccRequeues);
  const returnBoundaryBackwardSccRequeues = numberOrZero(details?.returnBoundaryBackwardSccRequeues);
  const returnBoundarySccRequeueSkippedAlreadyQueued = numberOrZero(details?.returnBoundarySccRequeueSkippedAlreadyQueued);
  const stage = details?.currentSccStage ? String(details.currentSccStage) : '';
  const cyclic = details?.currentSccCyclic ? 'cyclic' : 'acyclic';

  return (
    <div className="nv-analysis-log-detail-section">
      <div className="nv-analysis-log-stat-row">
        <span>SCC: {formatInteger(currentIndex)} / {formatInteger(total)}, {formatInteger(currentSize)} blocks, {cyclic}{stage ? `, ${stage}` : ''}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Largest SCC: {formatInteger(largestSize)} blocks; largest cyclic SCC: {formatInteger(largestCyclicSize)} blocks</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edges: {formatInteger(returnEdges)} total, {formatInteger(excludedReturnEdges)} excluded from SCC scheduling</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge summaries: {formatInteger(returnEdgeSummaryCount)} checked, {formatInteger(summaryUsableReturnEdges)} usable, {formatInteger(summaryRejectedReturnEdges)} rejected, {formatInteger(missingCallEdgeReturnEdges)} missing call edge, {formatInteger(missingCallTargetReturnEdges)} missing call target</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge summary rejects: {formatSummaryReturnRejectReasons(returnEdgeSummaryRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge stack rejects: {formatSummaryReturnStackRejectReasons(returnEdgeSummaryStackRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge indirect rejects: {formatDirectTransitiveReasons(returnEdgeSummaryIndirectRejectReasons, 'direct', 'direct JMP indirect')}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge unknown-call rejects: {formatDirectTransitiveReasons(returnEdgeSummaryUnknownCallRejectReasons, 'local', 'local missing call edge')}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge unknown-return rejects: {formatDirectTransitiveReasons(returnEdgeSummaryUnknownReturnRejectReasons, 'local', 'local unknown return')}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge no-normal rejects: {formatSummaryReturnNoNormalRejectReasons(returnEdgeSummaryNoNormalRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return edge not-always rejects: {formatSummaryReturnNotAlwaysRejectReasons(returnEdgeSummaryNotAlwaysRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Fallback return edge callees: {formatInteger(summaryRejectedReturnEdges)} edges, {formatInteger(returnEdgeSummaryRejectedDistinctCalleeCount)} distinct callees</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Top rejected return-edge callees: {formatReturnEdgeRejectSources(returnEdgeSummaryTopRejectSources)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>JSR returns: {formatInteger(summarizedCallReturns)} summarized, {formatInteger(unsummarizedCallReturns)} unsummarized, {formatInteger(deferredJsrFallthroughs)} deferred fallthroughs</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Summary-return rejects: {formatSummaryReturnRejectReasons(summaryReturnRejectReasons)}; no RTS fallback {formatInteger(rejectedSummaryNoRtsFallback)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Stack reject reasons: {formatSummaryReturnStackRejectReasons(summaryReturnStackRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>No-normal reject reasons: {formatSummaryReturnNoNormalRejectReasons(summaryReturnNoNormalRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>No-local-RTS details: {formatSummaryReturnNoLocalRtsDetails(summaryReturnNoLocalRtsDetails)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Not-always reject reasons: {formatSummaryReturnNotAlwaysRejectReasons(summaryReturnNotAlwaysRejectReasons)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return schedule direction: forward {formatInteger(returnForward)}, backward {formatInteger(returnBackward)}, same SCC {formatInteger(returnSameScc)}, missing SCC {formatInteger(returnMissingScc)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return boundary propagation: {formatInteger(returnBoundaryPropagations)} total; forward {formatInteger(returnBoundaryForward)}, backward {formatInteger(returnBoundaryBackward)}, missing SCC {formatInteger(returnBoundaryMissing)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return boundary changes: state {formatInteger(returnBoundaryStateChanges)}, context {formatInteger(returnBoundaryContextChanges)}; backward state {formatInteger(returnBoundaryBackwardStateChanges)}, backward context {formatInteger(returnBoundaryBackwardContextChanges)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Return boundary SCC requeues: {formatInteger(returnBoundarySccRequeues)} total; backward {formatInteger(returnBoundaryBackwardSccRequeues)}, already queued {formatInteger(returnBoundarySccRequeueSkippedAlreadyQueued)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Current SCC edges: internal {formatEdgeKindCounts(details?.currentSccInternalEdgesByKind)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Current SCC incoming edges: {formatEdgeKindCounts(details?.currentSccIncomingEdgesByKind)}</span>
      </div>
      <div className="nv-analysis-log-stat-row">
        <span>Current SCC outgoing edges: {formatEdgeKindCounts(details?.currentSccOutgoingEdgesByKind)}</span>
      </div>
    </div>
  );
}

function AbstractInterpretationWideningDetails({ details }) {
  const queuedBlocks = numberOrZero(details?.queuedBlocks);
  const iterations = numberOrZero(details?.iterations);
  const changedStates = numberOrZero(details?.changedStates);
  const stateJoins = numberOrZero(details?.stateJoins);
  const stateWidens = numberOrZero(details?.stateWidens);
  const stateWidenAttempts = numberOrZero(details?.stateWidenAttempts);
  const loopSummaryApplications = numberOrZero(details?.loopSummaryApplications);
  const loopSummaryWidenSuppressions = numberOrZero(details?.loopSummaryWidenSuppressions);
  const returnContextChanges = numberOrZero(details?.returnContextChangedStates);
  const enqueuedBlocks = numberOrZero(details?.enqueuedBlocks);
  const enqueueStateChanges = numberOrZero(details?.enqueueStateChanges);
  const enqueueReturnContextChanges = numberOrZero(details?.enqueueReturnContextChanges);
  const enqueueSeedInputs = numberOrZero(details?.enqueueSeedInputs);
  const enqueueSkippedAlreadyQueued = numberOrZero(details?.enqueueSkippedAlreadyQueued);

  return (
    <div className="nv-analysis-log-detail-section">
      <div className="nv-analysis-log-detail-heading">Widening</div>
      <StatGrid>
        <Stat label="Worklist" value={`${formatInteger(queuedBlocks)} queued`} />
        <Stat label="Iterations" value={formatInteger(iterations)} />
        <Stat label="Changed states" value={formatInteger(changedStates)} />
        <Stat label="Joins" value={formatInteger(stateJoins)} />
        <Stat label="Widens" value={formatAttempts(stateWidens, stateWidenAttempts)} />
        <Stat label="Max worklist" value={formatInteger(details?.maxWorklistSize)} />
        <Stat label="Loop summaries" value={formatInteger(loopSummaryApplications)} />
        <Stat label="Widen suppressions" value={formatInteger(loopSummaryWidenSuppressions)} />
        <Stat label="Return context changes" value={formatInteger(returnContextChanges)} />
      </StatGrid>
      <div className="nv-analysis-log-stat-row">
        <span>Enqueues: {formatInteger(enqueuedBlocks)} total; state {formatInteger(enqueueStateChanges)}, return context {formatInteger(enqueueReturnContextChanges)}, seed {formatInteger(enqueueSeedInputs)}, already queued {formatInteger(enqueueSkippedAlreadyQueued)}</span>
      </div>
    </div>
  );
}

function AbstractInterpretationNarrowingDetails({ details }) {
  const stage = aiNarrowingStageLabel(details?.narrowingStage);
  const processed = numberOrZero(details?.narrowingProcessedBlocks);
  const total = numberOrZero(details?.narrowingTotalBlocks);
  const maxRounds = numberOrZero(details?.narrowingMaxRounds);
  const roundBase = numberOrZero(details?.narrowingRound);
  const stageKey = details?.narrowingStage;
  const activeRoundStages = new Set(['prepareRound', 'computeCandidates', 'applyCandidates', 'prepareNarrowingRound', 'computeNarrowingCandidates', 'applyNarrowingCandidates']);
  const currentRound = maxRounds > 0
    ? Math.min(maxRounds, roundBase + (activeRoundStages.has(stageKey) ? 1 : 0))
    : 0;
  const changedStates = numberOrZero(details?.narrowingChangedStates);
  const stateJoins = numberOrZero(details?.narrowingStateJoins);
  const stateNarrows = numberOrZero(details?.stateNarrows);
  const stateNarrowAttempts = numberOrZero(details?.stateNarrowAttempts);
  const loopSummaryApplications = numberOrZero(details?.narrowingLoopSummaryApplications);

  return (
    <div className="nv-analysis-log-detail-section">
      <div className="nv-analysis-log-detail-heading">Narrowing</div>
      {stage ? <div className="nv-analysis-log-detail-subheading">Stage: {stage}</div> : null}
      <ProgressBar
        value={processed}
        max={total}
        label={`${formatInteger(processed)} / ${formatInteger(total)} blocks`}
      />
      <StatGrid>
        <Stat label="Round" value={maxRounds > 0 ? `${formatInteger(currentRound)} / ${formatInteger(maxRounds)}` : '0 / 0'} />
        <Stat label="Completed rounds" value={formatInteger(details?.narrowingRounds)} />
        <Stat label="Changed states" value={formatInteger(changedStates)} />
        <Stat label="Joins" value={formatInteger(stateJoins)} />
        <Stat label="Narrows" value={formatAttempts(stateNarrows, stateNarrowAttempts)} />
        <Stat label="Loop summaries" value={formatInteger(loopSummaryApplications)} />
      </StatGrid>
    </div>
  );
}



function FindMonotoneTablesDetails({ details }) {
  const tablesFound = numberOrZero(details?.tablesFound);
  const longestTableEntries = numberOrZero(details?.longestTableEntries);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-monotone-tables-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Monotone tables: {formatInteger(tablesFound)} found, longest {formatInteger(longestTableEntries)} entries</span>
      </div>
    </div>
  );
}

function FindSplitPointerTablesDetails({ details }) {
  const tablesAdded = numberOrZero(details?.tablesAdded);
  const highRunsFound = numberOrZero(details?.highRunsFound);
  const readerWitnessesFound = numberOrZero(details?.readerWitnessesFound);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-split-pointer-tables-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Split pointer tables: {formatInteger(tablesAdded)} found, {formatInteger(highRunsFound)} high runs, {formatInteger(readerWitnessesFound)} reader witnesses</span>
      </div>
    </div>
  );
}

function PromotePointersDetails({ details }) {
  const promotedPointers = numberOrZero(details?.promotedPointers);
  const readerFunctions = numberOrZero(details?.readerFunctions);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-promote-pointers-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Promoted pointers: {formatInteger(promotedPointers)}, reader functions: {formatInteger(readerFunctions)}</span>
      </div>
    </div>
  );
}

function PopulateMemoryMapDetails({ details }) {
  const ramReads = numberOrZero(details?.ramReadFacts);
  const ramWrites = numberOrZero(details?.ramWriteFacts);
  const ramReadWrites = numberOrZero(details?.ramReadWriteFacts);
  const romReads = numberOrZero(details?.romReadFacts);
  const skipped = numberOrZero(details?.skippedUnknownAddress)
    + numberOrZero(details?.skippedHugeAddressSet)
    + numberOrZero(details?.skippedMixedAddressSpace)
    + numberOrZero(details?.skippedAmbiguousMapper)
    + numberOrZero(details?.skippedRomWrite)
    + numberOrZero(details?.skippedUnsupportedAccess);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-populate-memory-map-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Memory map: {formatInteger(ramReads)} RAM reads, {formatInteger(ramWrites)} RAM writes, {formatInteger(ramReadWrites)} RMW, {formatInteger(romReads)} ROM data reads</span>
      </div>
      <StatGrid>
        <Stat label="Blocks replayed" value={formatInteger(details?.blockInstancesVisited)} />
        <Stat label="Instructions" value={formatInteger(details?.instructionsReplayed)} />
        <Stat label="Facts" value={formatInteger(details?.accessFacts)} />
        <Stat label="Groups" value={formatInteger(details?.groups)} />
        <Stat label="Annotations" value={formatInteger(details?.annotations)} />
        <Stat label="Skipped" value={formatInteger(skipped)} />
      </StatGrid>
    </div>
  );
}

function DetectLoopsDetails({ details }) {
  const detected = numberOrZero(details?.detectedLoops);
  const candidates = numberOrZero(details?.candidateLoops);
  const summarized = numberOrZero(details?.skippedSummarizedLoops);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-detect-loops-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Detected loops: {formatInteger(detected)} from {formatInteger(candidates)} candidates, {formatInteger(summarized)} already summarized</span>
      </div>
      <StatGrid>
        <Stat label="Vblank waits" value={formatInteger(details?.waitsForVblank)} />
        <Stat label="Sprite 0 waits" value={formatInteger(details?.waitsForSprite0Hit)} />
        <Stat label="Flag waits" value={formatInteger(details?.waitsForFlag)} />
        <Stat label="Spin loops" value={formatInteger(details?.spinLoop)} />
      </StatGrid>
    </div>
  );
}

function DecorateLoopsDetails({ details }) {
  const skipped = numberOrZero(details?.skippedMissingAnchor)
    + numberOrZero(details?.skippedInvalidSpan)
    + numberOrZero(details?.skippedNoContainingDisplayBlock)
    + numberOrZero(details?.skippedCrossDisplayBlock)
    + numberOrZero(details?.skippedMultipleContainingDisplayBlocks)
    + numberOrZero(details?.skippedMissingDisplayLine)
    + numberOrZero(details?.skippedBackwardsOrZeroLineSpan)
    + numberOrZero(details?.skippedOther);

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-decorate-loops-detail">
      <div className="nv-analysis-log-stat-row">
        <span>Loop guides: {formatInteger(details?.materializedLoopGuides)} materialized from {formatInteger(details?.summarizedLoops)} summarized loops and {formatInteger(details?.detectedLoops)} detected loops</span>
      </div>
      <StatGrid>
        <Stat label="Materialized" value={formatInteger(details?.materializedLoopGuides)} />
        <Stat label="From summaries" value={formatInteger(details?.materializedSummaryLoopGuides)} />
        <Stat label="From detection" value={formatInteger(details?.materializedDetectedLoopGuides)} />
        <Stat label="Skipped" value={formatInteger(skipped)} />
        <Stat label="Missing anchors" value={formatInteger(details?.skippedMissingAnchor)} />
        <Stat label="Cross-block" value={formatInteger(details?.skippedCrossDisplayBlock)} />
        <Stat label="No display block" value={formatInteger(details?.skippedNoContainingDisplayBlock)} />
        <Stat label="Missing line" value={formatInteger(details?.skippedMissingDisplayLine)} />
      </StatGrid>
    </div>
  );
}

function AbstractInterpretationDetails({ details }) {
  const currentDetails = details?.current && typeof details.current === 'object' ? details.current : details;
  const wideningDetails = details?.widening && typeof details.widening === 'object'
    ? details.widening
    : (currentDetails?.mode === 'widening' ? currentDetails : null);
  const narrowingDetails = details?.narrowing && typeof details.narrowing === 'object'
    ? details.narrowing
    : (currentDetails?.mode === 'narrowing' ? currentDetails : null);
  const fallbackMode = currentDetails?.mode;

  return (
    <div className="nv-analysis-log-detail nv-analysis-log-abstract-interpretation-detail">
      <AbstractInterpretationReuseDetails details={currentDetails} />
      <AbstractInterpretationSccDetails details={currentDetails} />
      {wideningDetails ? <AbstractInterpretationWideningDetails details={wideningDetails} /> : null}
      {narrowingDetails ? <AbstractInterpretationNarrowingDetails details={narrowingDetails} /> : null}
      {!wideningDetails && !narrowingDetails ? (
        <div className="nv-analysis-log-detail-heading">Mode: {aiModeLabel(fallbackMode)}</div>
      ) : null}
    </div>
  );
}

export function renderAnalysisPhaseDetails({ detailState }) {
  if (!detailState || typeof detailState !== 'object') return null;
  if (detailState.detailKind === 'functionExcavation') {
    return <FunctionExcavationDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'functionSummarization') {
    return <FunctionSummarizationDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'strictCfg') {
    return <StrictCfgDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'abstractInterpretation') {
    return <AbstractInterpretationDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'detectLoops') {
    return <DetectLoopsDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'populateMemoryMap') {
    return <PopulateMemoryMapDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'decorateLoops') {
    return <DecorateLoopsDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'findMonotoneTables') {
    return <FindMonotoneTablesDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'findSplitPointerTables') {
    return <FindSplitPointerTablesDetails details={detailState.details} />;
  }
  if (detailState.detailKind === 'promotePointers') {
    return <PromotePointersDetails details={detailState.details} />;
  }
  return null;
}
