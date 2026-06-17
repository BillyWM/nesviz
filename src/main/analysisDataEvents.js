import { notifyGraphDataChanged } from './graphWindow.js';
import { notifyMemoryMapDataChanged } from './memoryMapWindow.js';

export function notifyAnalysisDataChanged() {
  try { notifyMemoryMapDataChanged(); } catch {}
  try { notifyGraphDataChanged(); } catch {}
}
