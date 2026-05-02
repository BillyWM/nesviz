export function intersectSorted(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

export function intersectNonEmpty(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  const setB = new Set(b);
  for (const item of a) {
    if (setB.has(item)) return true;
  }
  return false;
}

export function intersectAllOffsetSets(offsetSets) {
  if (!offsetSets.length) return [];
  let cur = new Set(offsetSets[0]);
  for (let i = 1; i < offsetSets.length; i++) {
    const next = new Set(offsetSets[i]);
    cur = new Set(Array.from(cur).filter((off) => next.has(off)));
    if (!cur.size) break;
  }
  return Array.from(new Set(Array.from(cur)
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v))
    .map((v) => v >>> 0)))
    .sort((a, b) => a - b);
}

export function unionAllOffsetSets(offsetSets) {
  const out = new Set();
  for (const offsets of offsetSets || []) {
    for (const off of offsets || []) out.add(off >>> 0);
  }
  return Array.from(new Set(Array.from(out)
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v))
    .map((v) => v >>> 0)))
    .sort((a, b) => a - b);
}
