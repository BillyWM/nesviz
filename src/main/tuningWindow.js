import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';
import { getTuningState, setTuningUpdateListener } from './tuningState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let tuningWindow = null;
let removeListener = null;

export function setMainWindow(win) {
  mainWindow = win;
}

function broadcastTuning() {
  if (!tuningWindow || tuningWindow.isDestroyed()) return;
  try {
    tuningWindow.webContents.send('nesviz:tuningUpdated', { tuning: getTuningState() });
  } catch {}
}

export function showTuningWindow() {
  if (tuningWindow && !tuningWindow.isDestroyed()) {
    tuningWindow.show();
    tuningWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('tuning', { width: 520, height: 620 });
  tuningWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });
  applyMaximizedIfNeeded(tuningWindow, maximized);
  attachSaveOnClose(tuningWindow, 'tuning');
  try {
    tuningWindow.setMenu(null);
    tuningWindow.setMenuBarVisibility(false);
  } catch {}
  tuningWindow.on('closed', () => {
    tuningWindow = null;
    try { removeListener?.(); } catch {}
    removeListener = null;
  });
  removeListener = setTuningUpdateListener(() => broadcastTuning());
  loadRendererWindow(tuningWindow, 'tuning.html', __dirname);
  tuningWindow.webContents.once('did-finish-load', () => broadcastTuning());
}
