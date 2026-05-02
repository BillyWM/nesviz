import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { attachDevToolsShortcut, loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let graphWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showGraphWindow() {
  if (graphWindow && !graphWindow.isDestroyed()) {
    graphWindow.show();
    graphWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('graph', { width: 1500, height: 960 });

  graphWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    title: 'Graph',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(graphWindow, maximized);
  attachSaveOnClose(graphWindow, 'graph');

  try {
    graphWindow.setMenu(null);
    graphWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported.
  }

  graphWindow.on('closed', () => {
    graphWindow = null;
  });

  attachDevToolsShortcut(graphWindow);
  loadRendererWindow(graphWindow, 'graph.html', __dirname);
}

export function notifyGraphDataChanged() {
  if (!graphWindow || graphWindow.isDestroyed()) return;
  try {
    graphWindow.webContents.send('nesviz:graphDataChanged');
  } catch {
    // Ignore send failures.
  }
}
