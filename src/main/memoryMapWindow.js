import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let memoryMapWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

function getDevRendererUrl() {
  return (
    process.env.VITE_DEV_SERVER_URL ||
    process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL ||
    process.env.ELECTRON_RENDERER_URL ||
    null
  );
}

function loadMemoryMapWindow(win) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/memorymap.html`);
    return;
  }

  const htmlPath = path.join(__dirname, '../renderer/memorymap.html');
  win.loadFile(htmlPath);
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

  loadMemoryMapWindow(memoryMapWindow);
}

export function notifyMemoryMapDataChanged() {
  if (!memoryMapWindow || memoryMapWindow.isDestroyed()) return;
  try {
    memoryMapWindow.webContents.send('nesviz:memoryMapDataChanged');
  } catch {
    // Ignore send failures.
  }
}
