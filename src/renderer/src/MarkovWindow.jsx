import { useCallback, useState } from 'react';

const CARD_STYLE = {
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 10,
  padding: 14,
  background: 'rgba(255, 255, 255, 0.02)'
};

const MONO_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0
};

export default function MarkovWindow() {
  const [source, setSource] = useState('confirmed');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [isTraining, setIsTraining] = useState(false);

  const onTrain = useCallback(async () => {
    setIsTraining(true);
    setStatus('Training…');
    setResult(null);
    try {
      const res = await window.nesviz?.markovTrainOpcodeModel?.({ source });
      if (!res?.ok) {
        setStatus(res?.error || 'Training failed');
        return;
      }
      setResult(res);
      setStatus('Training complete.');
    } catch (e) {
      setStatus(`Training failed: ${e?.message ?? String(e)}`);
    } finally {
      setIsTraining(false);
    }
  }, [source]);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">Markov</div>
      </div>

      <div className="nv-modal-meta">
        <span className="nv-badge">Debug</span>
        {status ? <span className="nv-badge">{status}</span> : null}
      </div>

      <div className="nv-modal-list" style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <section style={CARD_STYLE}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Opcode Markov</div>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>
            Train opcode, addressing-mode, and mnemonic Markov artifacts from cached analysis across all available ROMs.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="radio"
                name="opcodeMarkovSource"
                checked={source === 'confirmed'}
                onChange={() => setSource('confirmed')}
              />
              <span>Confirmed code</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="radio"
                name="opcodeMarkovSource"
                checked={source === 'probablePlus'}
                onChange={() => setSource('probablePlus')}
              />
              <span>Probable code</span>
            </label>
          </div>

          <button
            type="button"
            className="nv-btn"
            title="Train from cached analysis"
            onClick={onTrain}
            disabled={isTraining}
          >
            Train
          </button>
        </section>

        <section style={CARD_STYLE}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Result</div>
          {result ? (
            <pre style={MONO_STYLE}>{[
              `Corpus: ${result.source === 'probablePlus' ? 'Probable code' : 'Confirmed code'}`,
              `Cache files scanned: ${result.cacheCount ?? 0}`,
              `Analyses used: ${result.usedAnalysisCount ?? 0}`,
              `Blocks used: ${result.usedBlockCount ?? 0}`,
              `Instruction count: ${result.usedInstructionCount ?? 0}`,
              `Opcode sequences: ${result.sequenceCounts?.opcode ?? 0}`,
              `Addressing sequences: ${result.sequenceCounts?.addressing ?? 0}`,
              `Mnemonic sequences: ${result.sequenceCounts?.mnemonic ?? 0}`,
              `Profile samples: ${result.profileSampleCount ?? 0}`,
              `Saved opcode model: ${result.modelPaths?.opcode || ''}`,
              `Saved addressing model: ${result.modelPaths?.addressing || ''}`,
              `Saved mnemonic model: ${result.modelPaths?.mnemonic || ''}`,
              `Saved combined profile: ${result.profilePath || ''}`
            ].join('\n')}</pre>
          ) : (
            <div className="nv-modal-empty">No training run yet.</div>
          )}
        </section>
      </div>
    </div>
  );
}
