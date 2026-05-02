import { screen } from 'electron';

import { getWindowState, getWindowStateSync, setWindowState } from './userDataStore.js';
import { clamp } from '../shared/utils/numberUtils.js';

function getUnionWorkArea() {
  // Work around multi-monitor by building a coarse union rect.
  const displays = screen.getAllDisplays();
  if (!displays || displays.length === 0) return { x: 0, y: 0, width: 1920, height: 1080 };

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const d of displays) {
    const wa = d.workArea || d.bounds;
    if (!wa) continue;
    left = Math.min(left, wa.x);
    top = Math.min(top, wa.y);
    right = Math.max(right, wa.x + wa.width);
    bottom = Math.max(bottom, wa.y + wa.height);
  }

  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    const primary = screen.getPrimaryDisplay();
    const wa = primary?.workArea || primary?.bounds;
    return wa || { x: 0, y: 0, width: 1920, height: 1080 };
  }

  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function sanitizeBounds(bounds, fallback) {
  const wa = getUnionWorkArea();
  const minW = 320;
  const minH = 240;

  const fb = fallback || {};
  let width = Number.isFinite(bounds?.width) ? bounds.width : fb.width;
  let height = Number.isFinite(bounds?.height) ? bounds.height : fb.height;
  width = Number.isFinite(width) ? width : 800;
  height = Number.isFinite(height) ? height : 600;
  width = Math.max(minW, width | 0);
  height = Math.max(minH, height | 0);

  // Clamp size to something reasonable within the union work area.
  width = clamp(width, minW, Math.max(minW, wa.width));
  height = clamp(height, minH, Math.max(minH, wa.height));

  let x = Number.isFinite(bounds?.x) ? bounds.x : fb.x;
  let y = Number.isFinite(bounds?.y) ? bounds.y : fb.y;

  // If we don't have a position, center on the primary display.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const primary = screen.getPrimaryDisplay();
    const pwa = primary?.workArea || primary?.bounds || wa;
    x = (pwa.x + (pwa.width - width) / 2) | 0;
    y = (pwa.y + (pwa.height - height) / 2) | 0;
  }

  // Ensure at least some of the window stays in view.
  const margin = 40;
  const maxX = wa.x + wa.width - margin;
  const maxY = wa.y + wa.height - margin;
  x = clamp(x | 0, wa.x - width + margin, maxX);
  y = clamp(y | 0, wa.y - height + margin, maxY);

  return { x, y, width, height };
}

export async function getInitialWindowState(key, fallbackBounds) {
  const stored = getWindowStateSync(key) || (await getWindowState(key));
  const maximized = !!stored?.maximized;
  const bounds = sanitizeBounds(stored, fallbackBounds);
  return { bounds, maximized };
}

export function getInitialWindowStateSync(key, fallbackBounds) {
  const stored = getWindowStateSync(key);
  const maximized = !!stored?.maximized;
  const bounds = sanitizeBounds(stored, fallbackBounds);
  return { bounds, maximized };
}

export function applyMaximizedIfNeeded(win, maximized) {
  if (!win || win.isDestroyed?.()) return;
  if (!maximized) return;
  try {
    win.maximize();
  } catch {
    // Ignore.
  }
}

export function attachSaveOnClose(win, key) {
  if (!win) return;
  let closing = false;

  win.on('close', (e) => {
    if (closing) return;
    closing = true;
    try {
      e.preventDefault();
    } catch {
      // If preventDefault fails, still try to save.
    }

    (async () => {
      try {
        const maximized = !!win.isMaximized?.();
        let b;
        try {
          b = maximized && win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
        } catch {
          b = null;
        }
        const bounds = sanitizeBounds(b, null);
        await setWindowState(key, { ...bounds, maximized });
      } catch {
        // Ignore persistence failures.
      }
    })().finally(() => {
      try {
        // Destroy directly to avoid re-entering close handlers.
        win.destroy();
      } catch {
        // Ignore.
      }
    });
  });
}
