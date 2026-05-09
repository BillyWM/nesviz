import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';
import { showAndFocusWindow } from './utils/windowFocusUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let labelsWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showLabelsWindow() {
  if (labelsWindow && !labelsWindow.isDestroyed()) {
    labelsWindow.show();
    labelsWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('labels', { width: 560, height: 720 });

  labelsWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(labelsWindow, maximized);
  attachSaveOnClose(labelsWindow, 'labels');

  // Hide menu bar on Windows/Linux. (macOS uses a global app menu.)
  try {
    labelsWindow.setMenu(null);
    labelsWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported on the platform/electron version.
  }

  labelsWindow.on('closed', () => {
    labelsWindow = null;
  });

  loadRendererWindow(labelsWindow, 'labels.html', __dirname);
}

export function registerLabelsIpc() {
  ipcMain.on('nesviz:labels:navigate', (_evt, payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      showAndFocusWindow(mainWindow);
      mainWindow.webContents.send('nesviz:labelsNavigate', payload);
    } catch {
      // Ignore.
    }
  });
}
