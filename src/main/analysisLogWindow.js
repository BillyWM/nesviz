import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let analysisLogWindow = null;
let analysisLogLines = [];

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

function loadAnalysisLogWindow(win) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/analysislog.html`);
    return;
  }

  const htmlPath = path.join(__dirname, '../renderer/analysislog.html');
  win.loadFile(htmlPath);
}

function broadcastAnalysisLog() {
  if (!analysisLogWindow || analysisLogWindow.isDestroyed()) return;
  try {
    analysisLogWindow.webContents.send('nesviz:analysisLogUpdated', { lines: analysisLogLines.slice() });
  } catch {
    // Ignore send failures.
  }
}

export function appendAnalysisLogLines(lines) {
  const items = (Array.isArray(lines) ? lines : [lines])
    .map((x) => (x ?? '').toString())
    .map((x) => x.trim())
    .filter(Boolean);
  if (!items.length) return;
  analysisLogLines = analysisLogLines.concat(items);
  if (analysisLogLines.length > 500) {
    analysisLogLines = analysisLogLines.slice(-500);
  }
  broadcastAnalysisLog();
}

export function getAnalysisLogLines() {
  return analysisLogLines.slice();
}

export function showAnalysisLogWindow() {
  if (analysisLogWindow && !analysisLogWindow.isDestroyed()) {
    analysisLogWindow.show();
    analysisLogWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('analysislog', { width: 720, height: 420 });

  analysisLogWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(analysisLogWindow, maximized);
  attachSaveOnClose(analysisLogWindow, 'analysislog');

  try {
    analysisLogWindow.setMenu(null);
    analysisLogWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore.
  }

  analysisLogWindow.on('closed', () => {
    analysisLogWindow = null;
  });

  loadAnalysisLogWindow(analysisLogWindow);
  analysisLogWindow.webContents.once('did-finish-load', () => {
    broadcastAnalysisLog();
  });
}

export function registerAnalysisLogIpc() {
  ipcMain.handle('nesviz:getAnalysisLog', async () => ({ ok: true, lines: analysisLogLines.slice() }));
}
