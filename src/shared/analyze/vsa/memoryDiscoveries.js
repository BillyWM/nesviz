import { buildStreamFootprints } from './streamFootprints.js';
import { buildAddressFacts } from './addressFacts.js';
import { deriveAddressPredicates } from './addressPredicates.js';
import { buildGroupMembership } from './groupMembership.js';
import { buildDiscoveryGroups } from './discoveryGroups.js';
import { buildGroupIndexes } from './groupIndexes.js';
import { buildOamDmaTransfers } from './oamDmaTransfers.js';
import { buildMapAnnotations } from '../mapAnnotations/buildMapAnnotations.js';

export function buildMemoryDiscoveries({ observationsResult, vsaDataflow, blockContextIndex = null, prgBytes = null, blocks = [], edges = [] }) {
  const streamFootprints = buildStreamFootprints({ observationsResult, vsaDataflow, prgBytes, blocks, edges });
  const addressFacts = buildAddressFacts({ observationsResult, vsaDataflow, blockContextIndex, streamFootprints });
  const addressPredicates = deriveAddressPredicates({ addressFacts });
  const groupMembership = buildGroupMembership({ addressFacts, addressPredicates });
  const discoveryGroups = buildDiscoveryGroups({ addressFacts, groupMembership });
  const groupIndexes = buildGroupIndexes({ groups: discoveryGroups.groups });
  const oamDmaTransfers = buildOamDmaTransfers({ observationsResult, blockContextIndex });
  const mapAnnotations = buildMapAnnotations({ addressFacts: addressFacts.addressFactsByKey, vsaDataflow, blockContextIndex, blocks });
  return {
    version: 6,
    blockContextIndex: blockContextIndex ? {
      rawBlockFamiliesById: blockContextIndex.rawBlockFamiliesByIdObject || {},
      rawBlockFunctionIdsById: blockContextIndex.rawBlockFunctionIdsByIdObject || {},
      functionInfoById: blockContextIndex.functionInfoByIdObject || {}
    } : null,
    streamFootprints: streamFootprints.footprints,
    addressFacts: addressFacts.addressFactsByKey,
    addressPredicates: addressPredicates.addressPredicatesByKey,
    groupMembership,
    groups: discoveryGroups.groups,
    groupIndexes,
    oamDmaTransfers: oamDmaTransfers.transfers,
    mapAnnotations,
    stats: {
      ...streamFootprints.stats,
      ...addressFacts.stats,
      ...addressPredicates.stats,
      ...groupMembership.stats,
      ...discoveryGroups.stats,
      ...groupIndexes.stats,
      ...oamDmaTransfers.stats,
      mapAnnotationCount: mapAnnotations.length
    }
  };
}
