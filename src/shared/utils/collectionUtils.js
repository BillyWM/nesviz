export function addMany(targetSet, values) {
  for (const value of values || []) targetSet.add(value);
}
