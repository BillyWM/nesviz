import path from 'node:path';

export function resolveFolderPath(p) {
  if (!p || typeof p !== 'string') return '';
  const trimmed = p.trim();
  return trimmed ? path.resolve(trimmed) : '';
}

export function normFolderPath(p) {
  const resolved = resolveFolderPath(p);
  if (!resolved) return '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function normalizeFolderPaths(folderPaths) {
  const rawPaths = Array.isArray(folderPaths)
    ? folderPaths
    : (typeof folderPaths === 'string' && folderPaths ? [folderPaths] : []);

  const out = [];
  const seen = new Set();
  for (const rawPath of rawPaths) {
    const resolved = resolveFolderPath(rawPath);
    if (!resolved) continue;
    const key = normFolderPath(resolved);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

export function getFolderSelectionKey(folderPaths) {
  return normalizeFolderPaths(folderPaths)
    .map((folderPath) => normFolderPath(folderPath))
    .sort()
    .join('\n');
}
