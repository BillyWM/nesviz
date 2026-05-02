import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let analysisLogWindow = null;
let analysisLogLines = [];

export function setMainWindow(win) {
  mainWindow = win;
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

  loadRendererWindow(analysisLogWindow, 'analysislog.html', __dirname);
  analysisLogWindow.webContents.once('did-finish-load', () => {
    broadcastAnalysisLog();
  });
}

export function registerAnalysisLogIpc() {
  ipcMain.handle('nesviz:getAnalysisLog', async () => ({ ok: true, lines: analysisLogLines.slice() }));
}
