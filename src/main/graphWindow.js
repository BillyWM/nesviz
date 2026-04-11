import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let graphWindow = null;

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

function loadGraphWindow(win) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/graph.html`);
    return;
  }

  const htmlPath = path.join(__dirname, '../renderer/graph.html');
  win.loadFile(htmlPath);
}

function attachGraphDevToolsShortcut(win) {
  const isDev = !!getDevRendererUrl();
  if (!isDev) return;

  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input?.key || '').toLowerCase();
    const hasPrimaryModifier = process.platform === 'darwin' ? !!input?.meta : !!input?.control;
    const hasShift = !!input?.shift;

    if (hasPrimaryModifier && hasShift && key === 'i') {
      event.preventDefault();
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });
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

  attachGraphDevToolsShortcut(graphWindow);
  loadGraphWindow(graphWindow);
}

export function notifyGraphDataChanged() {
  if (!graphWindow || graphWindow.isDestroyed()) return;
  try {
    graphWindow.webContents.send('nesviz:graphDataChanged');
  } catch {
    // Ignore send failures.
  }
}
