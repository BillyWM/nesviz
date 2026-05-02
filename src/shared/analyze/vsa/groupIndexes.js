import { addToArrayMap, finalizeArrayMap } from '../../utils/collectionMapUtils.js';

export function buildGroupIndexes({ groups }) {
  const groupsByAddressKey = new Map();
  const groupsByFunctionId = new Map();
  const groupsByRawBlockId = new Map();
  const groupsByTraceId = new Map();
  const groupsByKind = new Map();

  for (const group of groups || []) {
    const groupId = String(group.id);
    addToArrayMap(groupsByKind, group.kind, groupId);
    for (const key of group.memberAddressKeys || []) addToArrayMap(groupsByAddressKey, key, groupId);
    for (const functionId of group.touchingFunctionIds || []) addToArrayMap(groupsByFunctionId, functionId, groupId);
    for (const rawBlockId of group.touchingRawBlockIds || []) addToArrayMap(groupsByRawBlockId, rawBlockId, groupId);
    for (const traceId of group.traceIds || []) addToArrayMap(groupsByTraceId, traceId, groupId);
  }

  return {
    version: 1,
    groupsByAddressKey: finalizeArrayMap(groupsByAddressKey),
    groupsByFunctionId: finalizeArrayMap(groupsByFunctionId),
    groupsByRawBlockId: finalizeArrayMap(groupsByRawBlockId),
    groupsByTraceId: finalizeArrayMap(groupsByTraceId),
    groupsByKind: finalizeArrayMap(groupsByKind),
    stats: {
      indexedAddressCount: groupsByAddressKey.size,
      indexedFunctionCount: groupsByFunctionId.size,
      indexedRawBlockCount: groupsByRawBlockId.size,
      indexedTraceCount: groupsByTraceId.size
    }
  };
}
