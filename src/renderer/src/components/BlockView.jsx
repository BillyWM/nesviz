import { hex4, hex6 } from '../util/hex.js';

export function BlockView({ block }) {
  if (!block) {
    return (
      <div className="nv-empty">
        <div className="nv-empty-title">No block selected</div>
        <div className="nv-empty-sub">Select a discovered code block from the timeline.</div>
      </div>
    );
  }

  const cpuStart = block.instances?.[0]?.cpuStart;
  const cpuText = typeof cpuStart === 'number' ? `$${hex4(cpuStart)}` : '—';
  const romText = `${hex6(block.romStart)}–${hex6(block.romEnd)}`;

  return (
    <div className="nv-blockview">
      <div className="nv-block-header">
        <div className="nv-block-title">{block.id}</div>
        <div className="nv-block-meta">ROM {romText} · CPU {cpuText}</div>
      </div>

      <div className="nv-block-lines">
        {block.lines.map((line, index) => (
          <div key={typeof line.romOff === 'number' ? `rom:${line.romOff}` : `${line.cpuAddr}:${index}`} className="nv-line">
            <div className="nv-col-rom">{hex6(line.romOff)}</div>
            <div className="nv-col-cpu">${hex4(line.cpuAddr)}</div>
            <div className="nv-col-bytes">{line.bytesText}</div>
            <div className="nv-col-asm">{line.asm}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
