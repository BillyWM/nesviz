import { runConstantRecognizersForBlock } from './constantRecognizers.js';
import { runWaitLoopRecognizersForBlock } from './waitLoopRecognizers.js';

function addPill(block, pill) {
  if (!block || !pill) return;
  if (!Array.isArray(block.pills)) block.pills = [];
  if (!block.pills.includes(pill)) block.pills.push(pill);
}

export function runPointsOfInterestRecognizers(analysis) {
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const pointsOfInterest = [];

  for (const block of blocks) {
    const constPois = runConstantRecognizersForBlock(block);
    for (const p of constPois) {
      pointsOfInterest.push(p);
      if (p?.pill) addPill(block, p.pill);
    }

    const waitPois = runWaitLoopRecognizersForBlock(block);
    for (const p of waitPois) {
      pointsOfInterest.push(p);
      if (p?.pill) addPill(block, p.pill);
    }
  }

  analysis.pointsOfInterest = pointsOfInterest;
  return { pointsOfInterest };
}
