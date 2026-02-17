import { disasmOne } from '../../cpu6502/disasm.js';
import { blockIdFromRomOff } from '../model.js';

// Convert probable-code scan chunks into blocks compatible with the main UI model. 🤖
// These blocks are *not* considered certain; they are labeled with confidence:"probable" and can be upgraded later. 🤖

export function buildProbableBlocks({ prgBytes, mapper, ctxId, keptChunks, existingBlockIds }) {
  const blocks = [];

  for (const k of keptChunks) {
    const romStart = k.romStart | 0;
    const romEnd = k.romEnd | 0;
    const id = blockIdFromRomOff(romStart);
    if (existingBlockIds?.has(id)) continue;

    const cpuStarts = mapper.romOffToCpuAddrs?.(romStart) || [];
    const cpuStart = cpuStarts.length ? (cpuStarts[0] & 0xffff) : null;
    if (cpuStart == null) continue;

    const lines = [];
    for (const ins of k.chunk.instructions) {
      const cpuAddr = (cpuStart + (ins.off - romStart)) & 0xffff;
      const d = disasmOne(prgBytes, cpuAddr, ins.off);
      if (!d.ok) break;
      lines.push({
        cpuAddr,
        romOff: ins.off,
        len: d.len,
        bytesText: d.bytesText,
        asm: d.text,
        mnemonic: d.mnemonic,
        mode: d.mode,
        flow: d.flow
      });
    }

    const finalRomEnd = lines.length ? (lines[lines.length - 1].romOff + lines[lines.length - 1].len) : romEnd;

    blocks.push({
      id,
      romStart,
      romEnd: finalRomEnd,
      confidence: 'probable',
      probable: {
        totalScore: k.score.totalScore,
        decodedBytes: k.score.decodedBytes,
        branchHitRate: k.score.branchHitRate,
        reachableRatio: k.score.reachableRatio,
        details: k.score.details
      },
      instances: [{ ctxId, cpuStart }],
      lines
    });
  }

  blocks.sort((a, b) => a.romStart - b.romStart);
  return blocks;
}
