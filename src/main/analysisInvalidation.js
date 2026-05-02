import { deleteAnalysisCache } from './analysisCache.js';
import { deleteGraphLayoutCache } from './graphLayoutCache.js';

export async function invalidateAnalysisArtifacts(romHash) {
  if (!romHash) return;
  await Promise.allSettled([
    deleteAnalysisCache(romHash),
    deleteGraphLayoutCache(romHash)
  ]);
}
