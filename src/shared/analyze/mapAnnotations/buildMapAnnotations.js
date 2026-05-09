import { buildMapAnnotationsFromVsaHardwareFlows } from './fromVsaHardwareFlows.js';

export function buildMapAnnotations({ addressFacts, vsaDataflow = null, blockContextIndex = null, blocks = [] }) {
  return buildMapAnnotationsFromVsaHardwareFlows({ addressFacts, vsaDataflow, blockContextIndex, blocks });
}
