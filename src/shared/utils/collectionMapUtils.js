export function addToArrayMap(map, key, value) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}

export function finalizeArrayMap(map) {
  const out = {};
  for (const [key, values] of map.entries()) {
    out[key] = Array.from(new Set(values.map((v) => String(v)))).sort();
  }
  return out;
}

export function addToSetMap(map, key, values) {
  if (key == null) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  if (values instanceof Set) {
    for (const value of values) set.add(value);
    return;
  }
  if (Array.isArray(values)) {
    for (const value of values) set.add(value);
    return;
  }
  set.add(values);
}

export function addToSet(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}
