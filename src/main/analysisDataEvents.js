import { notifyGraphDataChanged } from './graphWindow.js';
import { notifyHeatmapDataChanged } from './heatmapWindow.js';
import { notifyMemoryMapDataChanged } from './memoryMapWindow.js';
import { notifyMarkovMapDataChanged } from './markov/markovMapWindow.js';

export function notifyAnalysisDataChanged() {
  try { notifyMemoryMapDataChanged(); } catch {}
  try { notifyHeatmapDataChanged(); } catch {}
  try { notifyMarkovMapDataChanged(); } catch {}
  try { notifyGraphDataChanged(); } catch {}
}
