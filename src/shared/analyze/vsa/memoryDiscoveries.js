import { buildStreamFootprints } from './streamFootprints.js';
import { buildAddressFacts } from './addressFacts.js';
import { deriveAddressPredicates } from './addressPredicates.js';
import { buildGroupMembership } from './groupMembership.js';
import { buildDiscoveryGroups } from './discoveryGroups.js';
import { buildGroupIndexes } from './groupIndexes.js';

export function buildMemoryDiscoveries({ observationsResult, vsaDataflow, blockContextIndex = null, prgBytes = null, blocks = [], edges = [] }) {
  const streamFootprints = buildStreamFootprints({ observationsResult, vsaDataflow, prgBytes, blocks, edges });
  const addressFacts = buildAddressFacts({ observationsResult, vsaDataflow, blockContextIndex, streamFootprints });
  const addressPredicates = deriveAddressPredicates({ addressFacts });
  const groupMembership = buildGroupMembership({ addressFacts, addressPredicates });
  const discoveryGroups = buildDiscoveryGroups({ addressFacts, groupMembership });
  const groupIndexes = buildGroupIndexes({ groups: discoveryGroups.groups });
  return {
    version: 2,
    blockContextIndex: blockContextIndex ? {
      blockFamiliesById: blockContextIndex.blockFamiliesByIdObject || {},
      blockFunctionIdsById: blockContextIndex.blockFunctionIdsByIdObject || {}
    } : null,
    streamFootprints: streamFootprints.footprints,
    addressFacts: addressFacts.addressFactsByKey,
    addressPredicates: addressPredicates.addressPredicatesByKey,
    groupMembership,
    groups: discoveryGroups.groups,
    groupIndexes,
    stats: {
      ...streamFootprints.stats,
      ...addressFacts.stats,
      ...addressPredicates.stats,
      ...groupMembership.stats,
      ...discoveryGroups.stats,
      ...groupIndexes.stats
    }
  };
}
