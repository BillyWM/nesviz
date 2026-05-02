export function getCurrentSelectionText() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return '';
  const text = selection.toString();
  return typeof text === 'string' ? text : '';
}

export function clampContextMenuPosition(x, y, width, height) {
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  return {
    x: Math.max(8, Math.min(x ?? 0, Math.max(8, w - width - 8))),
    y: Math.max(8, Math.min(y ?? 0, Math.max(8, h - height - 8)))
  };
}
