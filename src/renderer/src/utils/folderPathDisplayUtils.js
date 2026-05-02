export function normalizeFolderPathsValue(value) {
  const rawPaths = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value ? [value] : []);

  const out = [];
  const seen = new Set();
  for (const rawPath of rawPaths) {
    const nextPath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!nextPath || seen.has(nextPath)) continue;
    seen.add(nextPath);
    out.push(nextPath);
  }
  return out;
}

export function formatFolderPathsSubtitle(folderPaths) {
  return normalizeFolderPathsValue(folderPaths).join(', ');
}
