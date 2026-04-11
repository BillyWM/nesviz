function parseAddressKey(key) {
  const [space, addrText] = String(key || '').split(':');
  const addr = Number.parseInt(addrText, 10);
  if (!space || !Number.isFinite(addr)) return null;
  return { space, addr: space === 'rom' ? (addr >>> 0) : (addr & 0xffff) };
}

const GROUP_PREDICATE_FIELDS = [
  'nmiAssociated',
  'mainToNmiHandoff',
  'ppuFlowAssociated',
  'oamFlowAssociated',
  'usedAsPointer',
  'sharedByMultipleFunctions',
  'romDataObserved',
  'romStreamAssociated'
];

function predicateEnabled(value) {
  return value != null && value !== 'unknown';
}

export function buildGroupMembership({ addressFacts, addressPredicates }) {
  const factsByKey = addressFacts?.addressFactsByKey || {};
  const predicatesByKey = addressPredicates?.addressPredicatesByKey || {};
  const membershipsByAddressKey = {};
  const addressKeysByKind = {};
  const memberCountsByKind = {};

  for (const key of Object.keys(factsByKey)) {
    const parsed = parseAddressKey(key);
    if (!parsed) continue;
    const pred = predicatesByKey[key] || {};
    const kinds = GROUP_PREDICATE_FIELDS.filter((field) => predicateEnabled(pred[field]));
    if (!kinds.length) continue;
    membershipsByAddressKey[key] = {
      key,
      space: parsed.space,
      addr: parsed.addr,
      kinds
    };
    for (const kind of kinds) {
      if (!addressKeysByKind[kind]) addressKeysByKind[kind] = [];
      addressKeysByKind[kind].push(key);
      memberCountsByKind[kind] = (memberCountsByKind[kind] || 0) + 1;
    }
  }

  for (const keys of Object.values(addressKeysByKind)) keys.sort();

  return {
    version: 1,
    membershipsByAddressKey,
    addressKeysByKind,
    stats: {
      addressMembershipCount: Object.keys(membershipsByAddressKey).length,
      groupKindCount: Object.keys(addressKeysByKind).length,
      memberCountsByKind
    }
  };
}
