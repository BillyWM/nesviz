import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearAnalysisCache, getAnalysisCacheStats } from './analysisCache.js';
import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let preferencesWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

export function showPreferencesWindow() {
  if (preferencesWindow && !preferencesWindow.isDestroyed()) {
    preferencesWindow.show();
    preferencesWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('preferences', { width: 520, height: 360 });
  preferencesWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(preferencesWindow, maximized);
  attachSaveOnClose(preferencesWindow, 'preferences');

  try {
    preferencesWindow.setMenu(null);
    preferencesWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported on the platform/electron version.
  }

  preferencesWindow.on('closed', () => {
    preferencesWindow = null;
  });

  loadRendererWindow(preferencesWindow, 'preferences.html', __dirname);
}

export function registerPreferencesIpc() {
  ipcMain.handle('nesviz:preferences:getAnalysisCacheStats', async () => {
    return { ok: true, stats: await getAnalysisCacheStats() };
  });

  ipcMain.handle('nesviz:preferences:clearAnalysisCache', async () => {
    return { ok: true, stats: await clearAnalysisCache() };
  });
}
