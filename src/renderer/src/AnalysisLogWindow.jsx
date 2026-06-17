import { useEffect, useState } from 'react';
import { renderAnalysisPhaseDetails } from './analysisLogFormatters.jsx';

function formatElapsedMs(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return '';
  const totalSeconds = Math.max(0, elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - (minutes * 60);
  if (minutes > 0) return `${minutes}m ${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(2)}s`;
}

function applyElapsed(setElapsedByKey, key, elapsedMs) {
  if (!key || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return;
  setElapsedByKey((prev) => ({ ...prev, [key]: elapsedMs }));
}

function applyRound(setRoundByKey, key, message) {
  if (!key || !message || typeof message !== 'object') return;
  if (typeof message.groupId !== 'string' || !message.groupId) return;
  if (!Number.isInteger(message.groupIteration) || message.groupIteration <= 0) return;
  setRoundByKey((prev) => ({ ...prev, [key]: message.groupIteration }));
}

function mergeAbstractInterpretationDetails(previous, details) {
  const mode = typeof details.mode === 'string' && details.mode ? details.mode : null;
  const next = previous && typeof previous === 'object' ? { ...previous } : {};
  next.current = { ...details };
  if (mode === 'widening') next.widening = { ...details };
  if (mode === 'narrowing') next.narrowing = { ...details };
  return next;
}

function applyDetails(setDetailsByKey, key, message) {
  if (!key || !message || typeof message !== 'object') return;
  if (typeof message.detailKind !== 'string' || !message.detailKind) return;
  if (!message.details || typeof message.details !== 'object') return;
  setDetailsByKey((prev) => {
    const previous = prev[key];
    const nextDetails = message.detailKind === 'abstractInterpretation'
      ? mergeAbstractInterpretationDetails(previous?.details, message.details)
      : { ...message.details };
    return {
      ...prev,
      [key]: {
        detailKind: message.detailKind,
        details: nextDetails
      }
    };
  });
}

function applyGroupProgress(message, setPhaseStates, setElapsedByKey) {
  const groupKey = typeof message.groupLogKey === 'string' && message.groupLogKey ? message.groupLogKey : null;
  if (!groupKey) return;
  if (message.kind === 'phaseStarted') {
    setPhaseStates((prev) => ({ ...prev, [groupKey]: 'running' }));
  }
  applyElapsed(setElapsedByKey, groupKey, message.groupElapsedMs);
}

function applyProgressMessageToState(message, setters) {
  if (!message || typeof message !== 'object') return;
  const { setPhaseStates, setCurrentKey, setElapsedByKey, setRoundByKey, setDetailsByKey } = setters;

  if (message.kind === 'analysisReset') {
    setPhaseStates({});
    setElapsedByKey({});
    setRoundByKey({});
    setDetailsByKey({});
    setCurrentKey(null);
    return;
  }

  const logKey = typeof message.logKey === 'string' && message.logKey ? message.logKey : null;
  if (!logKey) return;

  applyGroupProgress(message, setPhaseStates, setElapsedByKey);
  applyElapsed(setElapsedByKey, logKey, message.elapsedMs);
  applyRound(setRoundByKey, logKey, message);
  applyDetails(setDetailsByKey, logKey, message);

  if (message.kind === 'phaseStarted') {
    setPhaseStates((prev) => ({ ...prev, [logKey]: 'running' }));
    setCurrentKey(logKey);
    return;
  }

  if (message.kind === 'phaseProgress') {
    return;
  }

  if (message.kind === 'phaseComplete') {
    setPhaseStates((prev) => ({ ...prev, [logKey]: 'complete' }));
    setCurrentKey((prev) => (prev === logKey ? null : prev));
  }
}

function PhaseHeader({ label, state = null, active = false, indent = false, elapsedMs = null, round = null, showRunningMarker = true }) {
  const complete = state === 'complete' && !active;
  const running = showRunningMarker && (active || state === 'running');
  const marker = running ? '→' : (complete ? '✓' : '');
  const elapsedText = formatElapsedMs(elapsedMs);
  const roundText = Number.isInteger(round) && round > 0 ? `Round ${round}` : '';

  return (
    <div className={`nv-analysis-log-phase${indent ? ' is-indented' : ''}${running ? ' is-running' : ''}`} aria-expanded="false">
      <span className="nv-analysis-log-check-slot" aria-hidden="true">{marker}</span>
      <span className="nv-analysis-log-heading-text">
        <span className="nv-analysis-log-title">{label}</span>
        <span className="nv-analysis-log-time" aria-label={elapsedText ? `Elapsed time ${elapsedText}` : undefined}>{elapsedText}</span>
        {roundText ? <span className="nv-analysis-log-round">{roundText}</span> : null}
      </span>
    </div>
  );
}

function PhaseBody({ detailState, indent = false }) {
  const details = renderAnalysisPhaseDetails({ detailState });
  if (!details) return <div className={`nv-analysis-log-lines is-collapsed${indent ? ' is-indented' : ''}`} aria-hidden="true" />;

  return (
    <div className={`nv-analysis-log-lines${indent ? ' is-indented' : ''}`}>
      {details}
    </div>
  );
}

function PhaseSection({ phase, phaseStates, currentKey, elapsedByKey, roundByKey, detailsByKey, indent = false }) {
  const state = phaseStates[phase.key] || null;
  const active = currentKey === phase.key;

  return (
    <section className={`nv-analysis-log-section${indent ? ' is-indented' : ''}`}>
      <PhaseHeader
        label={phase.label}
        state={state}
        active={active}
        indent={indent}
        elapsedMs={elapsedByKey[phase.key]}
        round={roundByKey[phase.key]}
      />
      <PhaseBody detailState={detailsByKey[phase.key]} indent={indent} />
    </section>
  );
}

function GroupSection({ group, phaseStates, currentKey, elapsedByKey, roundByKey, detailsByKey }) {
  const state = phaseStates[group.key] || null;

  return (
    <section className="nv-analysis-log-group">
      <PhaseHeader label={group.label} state={state} active={false} elapsedMs={elapsedByKey[group.key]} round={roundByKey[group.key]} showRunningMarker={false} />
      <PhaseBody detailState={detailsByKey[group.key]} />
      <div className="nv-analysis-log-group-phases">
        {group.phases.map((phase, index) => (
          <PhaseSection
            key={`${phase.key}:${index}`}
            phase={phase}
            phaseStates={phaseStates}
            currentKey={currentKey}
            elapsedByKey={elapsedByKey}
            roundByKey={roundByKey}
            detailsByKey={detailsByKey}
            indent
          />
        ))}
      </div>
    </section>
  );
}

function OutlineEntry({ entry, index, phaseStates, currentKey, elapsedByKey, roundByKey, detailsByKey }) {
  if (entry.kind === 'group') {
    return (
      <GroupSection
        key={`${entry.key || entry.id}:${index}`}
        group={entry}
        phaseStates={phaseStates}
        currentKey={currentKey}
        elapsedByKey={elapsedByKey}
        roundByKey={roundByKey}
        detailsByKey={detailsByKey}
      />
    );
  }

  return (
    <PhaseSection
      key={`${entry.key || entry.id}:${index}`}
      phase={entry}
      phaseStates={phaseStates}
      currentKey={currentKey}
      elapsedByKey={elapsedByKey}
      roundByKey={roundByKey}
      detailsByKey={detailsByKey}
    />
  );
}

export default function AnalysisLogWindow() {
  const [outline, setOutline] = useState([]);
  const [phaseStates, setPhaseStates] = useState({});
  const [elapsedByKey, setElapsedByKey] = useState({});
  const [roundByKey, setRoundByKey] = useState({});
  const [detailsByKey, setDetailsByKey] = useState({});
  const [currentKey, setCurrentKey] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;

    async function loadOutline() {
      try {
        const res = await window.nesviz.getAnalysisLogOutline();
        if (canceled) return;
        if (!res?.ok) {
          setError(res?.error || 'Failed to load analysis log outline');
          return;
        }
        setOutline(Array.isArray(res.outline) ? res.outline : []);
        const progressState = res.progressState && typeof res.progressState === 'object' ? res.progressState : null;
        setPhaseStates(progressState?.phaseStates && typeof progressState.phaseStates === 'object' ? progressState.phaseStates : {});
        setElapsedByKey(progressState?.phaseElapsedMs && typeof progressState.phaseElapsedMs === 'object' ? progressState.phaseElapsedMs : {});
        setRoundByKey(progressState?.phaseRounds && typeof progressState.phaseRounds === 'object' ? progressState.phaseRounds : {});
        setDetailsByKey(progressState?.phaseDetails && typeof progressState.phaseDetails === 'object' ? progressState.phaseDetails : {});
        setCurrentKey(typeof progressState?.currentKey === 'string' ? progressState.currentKey : null);
      } catch (e) {
        if (canceled) return;
        setError(e?.message ?? String(e));
      }
    }

    loadOutline();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    return window.nesviz.onVsaProgress((message) => {
      applyProgressMessageToState(message, {
        setPhaseStates,
        setCurrentKey,
        setElapsedByKey,
        setRoundByKey,
        setDetailsByKey
      });
    });
  }, []);

  return (
    <div className="nv-toolwindow nv-analysis-log-window">
      <div className="nv-modal-header nv-centered-tool-header">
        <div className="nv-centered-tool-header-spacer" aria-hidden="true" />
        <div className="nv-modal-title">Analysis Log</div>
        <div className="nv-centered-tool-header-spacer" aria-hidden="true" />
      </div>

      <div className="nv-analysis-log-list">
        {error ? (
          <div className="nv-analysis-log-error">{error}</div>
        ) : outline.map((entry, index) => (
          <OutlineEntry
            key={`${entry.key || entry.id}:${index}`}
            entry={entry}
            index={index}
            phaseStates={phaseStates}
            currentKey={currentKey}
            elapsedByKey={elapsedByKey}
            roundByKey={roundByKey}
            detailsByKey={detailsByKey}
          />
        ))}
      </div>
    </div>
  );
}
