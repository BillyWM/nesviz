import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { attachDevToolsShortcut, loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let heatmapWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showHeatmapWindow() {
  if (heatmapWindow && !heatmapWindow.isDestroyed()) {
    heatmapWindow.show();
    heatmapWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('heatmap', { width: 1320, height: 940 });

  heatmapWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    title: 'Heatmap',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(heatmapWindow, maximized);
  attachSaveOnClose(heatmapWindow, 'heatmap');

  try {
    heatmapWindow.setMenu(null);
    heatmapWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported.
  }

  heatmapWindow.on('closed', () => {
    heatmapWindow = null;
  });

  attachDevToolsShortcut(heatmapWindow);
  loadRendererWindow(heatmapWindow, 'heatmap.html', __dirname);
}

export function notifyHeatmapDataChanged() {
  if (!heatmapWindow || heatmapWindow.isDestroyed()) return;
  try {
    heatmapWindow.webContents.send('nesviz:heatmapDataChanged');
  } catch {
    // Ignore send failures.
  }
}
