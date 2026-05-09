import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';
import { showAndFocusWindow } from './utils/windowFocusUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let memoryMapWindow = null;
let mainWindowClosedHandler = null;

function closeMemoryMapWithMainWindow() {
  mainWindow = null;
  if (memoryMapWindow && !memoryMapWindow.isDestroyed()) {
    memoryMapWindow.close();
  }
}


function normalizeMemoryMapNavigatePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.kind !== 'rom') return null;
  const romOff = Number(payload.romOff);
  if (!Number.isInteger(romOff) || romOff < 0) return null;
  return { kind: 'rom', romOff: romOff >>> 0 };
}

export function registerMemoryMapWindowIpc() {
  ipcMain.on('nesviz:memoryMap:navigate', (_evt, payload) => {
    const msg = normalizeMemoryMapNavigatePayload(payload);
    if (!msg || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      showAndFocusWindow(mainWindow);
      mainWindow.webContents.send('nesviz:memoryMapNavigate', msg);
    } catch {
      // Ignore.
    }
  });
}

export function setMainWindow(win) {
  if (mainWindow && mainWindowClosedHandler) {
    mainWindow.removeListener('closed', mainWindowClosedHandler);
  }

  mainWindow = win;
  mainWindowClosedHandler = null;

  if (mainWindow) {
    mainWindowClosedHandler = closeMemoryMapWithMainWindow;
    mainWindow.on('closed', mainWindowClosedHandler);
  }
}

export function showMemoryMapWindow() {
  if (memoryMapWindow && !memoryMapWindow.isDestroyed()) {
    showAndFocusWindow(memoryMapWindow);
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('memoryMap', { width: 1280, height: 900 });

  memoryMapWindow = new BrowserWindow({
    ...bounds,
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
