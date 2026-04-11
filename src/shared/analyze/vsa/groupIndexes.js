function addToArrayMap(map, key, value) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}

function finalizeArrayMap(map) {
  const out = {};
  for (const [key, values] of map.entries()) {
    out[key] = Array.from(new Set(values.map((v) => String(v)))).sort();
  }
  return out;
}

export function buildGroupIndexes({ groups }) {
  const groupsByAddressKey = new Map();
  const groupsByFunctionId = new Map();
  const groupsByBlockId = new Map();
  const groupsByTraceId = new Map();
  const groupsByKind = new Map();

  for (const group of groups || []) {
    const groupId = String(group.id);
    addToArrayMap(groupsByKind, group.kind, groupId);
    for (const key of group.memberAddressKeys || []) addToArrayMap(groupsByAddressKey, key, groupId);
    for (const functionId of group.touchingFunctionIds || []) addToArrayMap(groupsByFunctionId, functionId, groupId);
    for (const blockId of group.touchingBlockIds || []) addToArrayMap(groupsByBlockId, blockId, groupId);
    for (const traceId of group.traceIds || []) addToArrayMap(groupsByTraceId, traceId, groupId);
  }

  return {
    version: 1,
    groupsByAddressKey: finalizeArrayMap(groupsByAddressKey),
    groupsByFunctionId: finalizeArrayMap(groupsByFunctionId),
    groupsByBlockId: finalizeArrayMap(groupsByBlockId),
    groupsByTraceId: finalizeArrayMap(groupsByTraceId),
    groupsByKind: finalizeArrayMap(groupsByKind),
    stats: {
      indexedAddressCount: groupsByAddressKey.size,
      indexedFunctionCount: groupsByFunctionId.size,
      indexedBlockCount: groupsByBlockId.size,
      indexedTraceCount: groupsByTraceId.size
    }
  };
}
