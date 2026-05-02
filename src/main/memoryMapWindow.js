import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let memoryMapWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showMemoryMapWindow() {
  if (memoryMapWindow && !memoryMapWindow.isDestroyed()) {
    memoryMapWindow.show();
    memoryMapWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('memoryMap', { width: 1280, height: 900 });

  memoryMapWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    title: 'Memory Map',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(memoryMapWindow, maximized);
  attachSaveOnClose(memoryMapWindow, 'memoryMap');

  try {
    memoryMapWindow.setMenu(null);
    memoryMapWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported.
  }

  memoryMapWindow.on('closed', () => {
    memoryMapWindow = null;
  });

  loadRendererWindow(memoryMapWindow, 'memorymap.html', __dirname);
}

export function notifyMemoryMapDataChanged() {
  if (!memoryMapWindow || memoryMapWindow.isDestroyed()) return;
  try {
    memoryMapWindow.webContents.send('nesviz:memoryMapDataChanged');
  } catch {
    // Ignore send failures.
  }
}
