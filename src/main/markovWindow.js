import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let markovWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showMarkovWindow() {
  if (markovWindow && !markovWindow.isDestroyed()) {
    markovWindow.show();
    markovWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('markov', { width: 700, height: 560 });

  markovWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    title: 'Markov',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(markovWindow, maximized);
  attachSaveOnClose(markovWindow, 'markov');

  try {
    markovWindow.setMenu(null);
    markovWindow.setMenuBarVisibility(false);
  } catch {}

  markovWindow.on('closed', () => {
    markovWindow = null;
  });

  loadRendererWindow(markovWindow, 'markov.html', __dirname);
}
