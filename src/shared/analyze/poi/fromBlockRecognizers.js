import { runConstantRecognizersForBlock } from '../recognize/constantRecognizers.js';
import { runWaitLoopRecognizersForBlock } from '../recognize/waitLoopRecognizers.js';
import { runPpuRecognizersForBlock } from '../recognize/ppuRecognizers.js';

export function collectPointsOfInterestFromBlockRecognizers(analysis) {
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const pointsOfInterest = [];
  const pillsByBlockId = {};

  for (const block of blocks) {
    const blockPois = [
      ...(runConstantRecognizersForBlock(block) || []),
      ...(runWaitLoopRecognizersForBlock(block) || []),
      ...(runPpuRecognizersForBlock(block) || [])
    ];
    for (const poi of blockPois) {
      if (!poi) continue;
      pointsOfInterest.push(poi);
      if (poi.pill && typeof block?.id === 'string' && block.id) {
        pillsByBlockId[block.id] = pillsByBlockId[block.id] || [];
        if (!pillsByBlockId[block.id].includes(poi.pill)) pillsByBlockId[block.id].push(poi.pill);
      }
    }
  }

  return { pointsOfInterest, pillsByBlockId };
}
