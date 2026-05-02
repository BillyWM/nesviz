import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let markovMapWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showMarkovMapWindow() {
  if (markovMapWindow && !markovMapWindow.isDestroyed()) {
    markovMapWindow.show();
    markovMapWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('markovMap', { width: 1280, height: 900 });

  markovMapWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    title: 'Markov map',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(markovMapWindow, maximized);
  attachSaveOnClose(markovMapWindow, 'markovMap');

  try {
    markovMapWindow.setMenu(null);
    markovMapWindow.setMenuBarVisibility(false);
  } catch {}

  markovMapWindow.on('closed', () => {
    markovMapWindow = null;
  });

  loadRendererWindow(markovMapWindow, 'markovmap.html', __dirname);
}

export function notifyMarkovMapDataChanged() {
  if (!markovMapWindow || markovMapWindow.isDestroyed()) return;
  try {
    markovMapWindow.webContents.send('nesviz:markovMapDataChanged');
  } catch {}
}
